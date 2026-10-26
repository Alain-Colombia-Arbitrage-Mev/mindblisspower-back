// Synthetic local integration utility. Uses the actual production Go verifier.
package main

import (
    "context"
    "encoding/json"
    "errors"
    "io"
    "os"
    "time"

    "github.com/vicionpower/vp-engine/internal/payments"
)

func main() {
    var input struct { Token string `json:"token"` }
    if err := json.NewDecoder(io.LimitReader(os.Stdin, 16384)).Decode(&input); err != nil { os.Exit(2) }
    ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
    defer cancel()
    verifier, err := payments.NewBetterAuthVerifier(ctx, "https://auth.core.internal/api/auth/jwks", "https://auth.synthetic.invalid", "synthetic-core")
    if err == nil {
        var email string
        email, err = verifier.VerifyEmail(ctx, input.Token)
        if err == nil && email != "transport-fixture@example.invalid" { err = errors.New("synthetic identity mismatch") }
    }
    if err != nil { os.Stdout.WriteString("{\"verified\":false}\n"); os.Exit(1) }
    os.Stdout.WriteString("{\"verified\":true,\"httpsJwks\":true}\n")
}
