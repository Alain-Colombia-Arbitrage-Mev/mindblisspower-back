package nowpayments

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// VerifyIPN authenticates the recursively key-sorted JSON body with the separate
// NOWPayments IPN secret. Signature verification never implies payment success.
func (c *Client) VerifyIPN(body []byte, signature string) (Payment, error) {
	if c == nil || c.ipnSecret == "" {
		return Payment{}, ErrConfiguration
	}
	if len(signature) != sha512.Size*2 {
		return Payment{}, ErrSignature
	}
	provided, err := hex.DecodeString(signature)
	if err != nil {
		return Payment{}, ErrSignature
	}
	canonical, err := canonicalJSON(body)
	if err != nil {
		return Payment{}, ErrSignature
	}
	mac := hmac.New(sha512.New, []byte(c.ipnSecret))
	_, _ = mac.Write(canonical) // hash.Hash.Write cannot fail.
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return Payment{}, ErrSignature
	}
	return decodePayment(body)
}

// Decode with UseNumber, reject duplicate keys, and limit recursion. A float64
// round-trip would silently alter payment identifiers and cryptocurrency values.
func canonicalJSON(body []byte) ([]byte, error) {
	if len(body) == 0 || len(body) > maxBody || !utf8.Valid(body) {
		return nil, ErrResponse
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	value, err := readJSON(d, 0)
	if err != nil {
		return nil, err
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, ErrResponse
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrResponse
	}
	return appendCanonical(nil, value)
}

func readJSON(d *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, ErrResponse
	}
	token, err := d.Token()
	if err != nil {
		return nil, ErrResponse
	}
	switch t := token.(type) {
	case json.Delim:
		switch t {
		case '{':
			object := map[string]any{}
			for d.More() {
				keyToken, err := d.Token()
				if err != nil {
					return nil, ErrResponse
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, ErrResponse
				}
				if _, exists := object[key]; exists {
					return nil, ErrResponse
				}
				value, err := readJSON(d, depth+1)
				if err != nil {
					return nil, err
				}
				object[key] = value
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return nil, ErrResponse
			}
			return object, nil
		case '[':
			array := []any{}
			for d.More() {
				value, err := readJSON(d, depth+1)
				if err != nil {
					return nil, err
				}
				array = append(array, value)
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return nil, ErrResponse
			}
			return array, nil
		default:
			return nil, ErrResponse
		}
	default:
		return token, nil
	}
}

func appendCanonical(dst []byte, value any) ([]byte, error) {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		dst = append(dst, '{')
		for i, key := range keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = appendJSONString(dst, key)
			dst = append(dst, ':')
			var err error
			dst, err = appendCanonical(dst, v[key])
			if err != nil {
				return nil, err
			}
		}
		return append(dst, '}'), nil
	case []any:
		dst = append(dst, '[')
		for i, item := range v {
			if i > 0 {
				dst = append(dst, ',')
			}
			var err error
			dst, err = appendCanonical(dst, item)
			if err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case string:
		return appendJSONString(dst, v), nil
	case json.Number:
		n, err := canonicalNumber(v.String())
		if err != nil {
			return nil, err
		}
		// The provider's reference signer uses JSON.stringify. Refuse a numeric
		// spelling that would lose precision there rather than silently rounding
		// an identifier, amount, or signature. This float is used ONLY to reject
		// ambiguous JSON; all evidence and currency arithmetic stays exact.
		f, err := strconv.ParseFloat(n, 64)
		if err != nil {
			return nil, ErrResponse
		}
		roundTrip, err := canonicalNumber(strconv.FormatFloat(f, 'g', -1, 64))
		if err != nil || roundTrip != n {
			return nil, ErrResponse
		}
		if !strings.ContainsAny(n, ".e") && (f > 9007199254740991 || f < -9007199254740991) {
			return nil, ErrResponse
		}
		return append(dst, n...), err
	case bool:
		return strconv.AppendBool(dst, v), nil
	case nil:
		return append(dst, "null"...), nil
	default:
		return nil, ErrResponse
	}
}

// JSON.stringify-compatible escaping without HTML or U+2028/U+2029 escaping.
func appendJSONString(dst []byte, value string) []byte {
	dst = append(dst, '"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			dst = append(dst, '\\', byte(r))
		case '\b':
			dst = append(dst, `\b`...)
		case '\f':
			dst = append(dst, `\f`...)
		case '\n':
			dst = append(dst, `\n`...)
		case '\r':
			dst = append(dst, `\r`...)
		case '\t':
			dst = append(dst, `\t`...)
		default:
			if r < 0x20 {
				const digits = "0123456789abcdef"
				dst = append(dst, '\\', 'u', '0', '0', digits[r>>4], digits[r&15])
			} else {
				dst = utf8.AppendRune(dst, r)
			}
		}
	}
	return append(dst, '"')
}

var numberPattern = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$`)

// Normalize decimal spelling, not precision: 1.00 -> 1 and 1e-6 -> 0.000001.
// Limits keep hostile exponents and big.Rat allocations bounded.
func canonicalNumber(raw string) (string, error) {
	if len(raw) == 0 || len(raw) > 512 {
		return "", ErrResponse
	}
	parts := numberPattern.FindStringSubmatch(raw)
	if parts == nil {
		return "", ErrResponse
	}
	exponent := 0
	if parts[4] != "" {
		var err error
		exponent, err = strconv.Atoi(parts[4])
		if err != nil || exponent < -1000 || exponent > 1000 {
			return "", ErrResponse
		}
	}
	digits := strings.TrimLeft(parts[2]+parts[3], "0")
	if digits == "" {
		return "0", nil
	}
	point := len(digits) + exponent - len(parts[3])
	digits = strings.TrimRight(digits, "0")
	sign := parts[1]
	if point > 0 && point <= 21 {
		if point >= len(digits) {
			return sign + digits + strings.Repeat("0", point-len(digits)), nil
		}
		return sign + digits[:point] + "." + digits[point:], nil
	}
	if point <= 0 && point > -6 {
		return sign + "0." + strings.Repeat("0", -point) + digits, nil
	}
	mantissa := digits[:1]
	if len(digits) > 1 {
		mantissa += "." + digits[1:]
	}
	e := point - 1
	es := strconv.Itoa(e)
	if e >= 0 {
		es = "+" + es
	}
	return sign + mantissa + "e" + es, nil
}
