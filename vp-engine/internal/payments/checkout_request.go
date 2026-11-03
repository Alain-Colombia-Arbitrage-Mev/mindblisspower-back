package payments

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"
)

var errInvalidCheckoutJSON = errors.New("invalid checkout JSON")

// Keep the existing BFF field types, optional fields, order and whitespace.
// Unlike direct struct decoding, this rejects unknown/case-folded aliases and
// duplicate decoded keys before an identity, database or provider is consulted.
func decodeCheckoutRequest(w http.ResponseWriter, r *http.Request) (checkoutRequest, error) {
	var out checkoutRequest
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil || !utf8.Valid(body) {
		return out, errInvalidCheckoutJSON
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return out, errInvalidCheckoutJSON
	}
	seen := make(map[string]bool, 8)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return out, errInvalidCheckoutJSON
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return out, errInvalidCheckoutJSON
		}
		switch key {
		case "email", "package_id", "ref", "preferred_side", "name", "phone", "provider", "purchase_request_id":
		default:
			return out, errInvalidCheckoutJSON
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return out, errInvalidCheckoutJSON
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || !errors.Is(decoder.Decode(&struct{}{}), io.EOF) || json.Unmarshal(body, &out) != nil {
		return out, errInvalidCheckoutJSON
	}
	return out, nil
}
