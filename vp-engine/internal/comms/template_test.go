package comms

import (
	"strings"
	"testing"
)

func TestRenderSanitizesAndAddsFooter(t *testing.T) {
	out, err := Render(RenderInput{
		Subject:        "Novedades",
		BodyMarkdown:   "Hola **equipo**\n\n<script>alert(1)</script>\n\n[Entrar](https://app.mindblisspower.com)\n\n<iframe src=\"x\"></iframe>",
		FirstName:      "Ana",
		UnsubscribeURL: "https://app.mindblisspower.com/baja?t=abc",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(out.HTML, "<script") || strings.Contains(out.HTML, "<iframe") {
		t.Fatalf("html not sanitized: %s", out.HTML)
	}
	for _, must := range []string{"<strong>equipo</strong>", `href="https://app.mindblisspower.com"`, "Hola Ana", "Darse de baja", "https://app.mindblisspower.com/baja?t=abc", "carpeta de spam"} {
		if !strings.Contains(out.HTML, must) {
			t.Fatalf("html missing %q:\n%s", must, out.HTML)
		}
	}
	for _, must := range []string{"Hola **equipo**", "Darse de baja: https://app.mindblisspower.com/baja?t=abc"} {
		if !strings.Contains(out.Text, must) {
			t.Fatalf("text missing %q:\n%s", must, out.Text)
		}
	}
	if out.Subject != "Novedades" {
		t.Fatalf("subject = %q", out.Subject)
	}
}

func TestRenderRejectsHTTPLinksAndRequiresUnsubscribe(t *testing.T) {
	out, err := Render(RenderInput{Subject: "x", BodyMarkdown: "[mal](http://evil.test) [js](javascript:alert(1))", UnsubscribeURL: "https://a/b"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(out.HTML, "http://evil.test") || strings.Contains(out.HTML, "javascript:") {
		t.Fatalf("insecure links kept: %s", out.HTML)
	}
	if _, err := Render(RenderInput{Subject: "x", BodyMarkdown: "hola"}); err == nil {
		t.Fatal("expected error without UnsubscribeURL")
	}
}

func TestRenderGreetingWithoutName(t *testing.T) {
	out, _ := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", UnsubscribeURL: "https://a/b"})
	if !strings.Contains(out.HTML, "Hola,") {
		t.Fatalf("generic greeting missing:\n%s", out.HTML)
	}
}
