package comms

import (
	"strings"
	"testing"
)

const (
	testLegalName     = "Mindbliss Power SAS"
	testPostalAddress = "Calle 1 # 2-3, Bogotá"
)

func TestRenderSanitizesAndAddsFooter(t *testing.T) {
	out, err := Render(RenderInput{
		Subject:        "Novedades",
		BodyMarkdown:   "Hola **equipo**\n\n<script>alert(1)</script>\n\n[Entrar](https://app.mindblisspower.com)\n\n<iframe src=\"x\"></iframe>",
		FirstName:      "Ana",
		UnsubscribeURL: "https://app.mindblisspower.com/baja?t=abc",
		LegalName:      testLegalName,
		PostalAddress:  testPostalAddress,
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
	// CAN-SPAM / GDPR: el pie debe identificar a la entidad legal y su dirección postal.
	for _, must := range []string{testLegalName, testPostalAddress, testLegalName + " · " + testPostalAddress} {
		if !strings.Contains(out.HTML, must) {
			t.Fatalf("html footer missing legal identity %q:\n%s", must, out.HTML)
		}
		if !strings.Contains(out.Text, must) {
			t.Fatalf("text footer missing legal identity %q:\n%s", must, out.Text)
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

func TestRenderRequiresLegalName(t *testing.T) {
	if _, err := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", UnsubscribeURL: "https://a/b"}); err == nil {
		t.Fatal("expected error without LegalName")
	}
	// PostalAddress vacío es válido: se omite el separador " · ".
	out, err := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", UnsubscribeURL: "https://a/b", LegalName: testLegalName})
	if err != nil {
		t.Fatalf("Render sin PostalAddress: %v", err)
	}
	if !strings.Contains(out.HTML, testLegalName) || strings.Contains(out.HTML, testLegalName+" · ") {
		t.Fatalf("footer sin dirección postal mal formado:\n%s", out.HTML)
	}
	if !strings.Contains(out.Text, testLegalName) || strings.Contains(out.Text, testLegalName+" · ") {
		t.Fatalf("text footer sin dirección postal mal formado:\n%s", out.Text)
	}
}

func TestRenderRejectsHTTPLinksAndRequiresUnsubscribe(t *testing.T) {
	out, err := Render(RenderInput{Subject: "x", BodyMarkdown: "[mal](http://evil.test) [js](javascript:alert(1))",
		UnsubscribeURL: "https://a/b", LegalName: testLegalName, PostalAddress: testPostalAddress})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if strings.Contains(out.HTML, "http://evil.test") || strings.Contains(out.HTML, "javascript:") {
		t.Fatalf("insecure links kept: %s", out.HTML)
	}
	if strings.Contains(out.Text, "http://evil.test") || strings.Contains(out.Text, "javascript:") {
		t.Fatalf("insecure links kept in text: %s", out.Text)
	}
	// Autolinks <http://…> y URLs desnudas también deben desaparecer (I9): el texto
	// alternativo se construye del markdown crudo, así que el filtro va antes.
	out, err = Render(RenderInput{Subject: "x", BodyMarkdown: "<http://evil.test> visita http://evil2.test y javascript:alert(1)",
		UnsubscribeURL: "https://a/b", LegalName: testLegalName, PostalAddress: testPostalAddress})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	for _, bad := range []string{"evil.test", "evil2.test", "javascript:"} {
		if strings.Contains(out.HTML, bad) {
			t.Fatalf("html keeps %q:\n%s", bad, out.HTML)
		}
		if strings.Contains(out.Text, bad) {
			t.Fatalf("text keeps %q:\n%s", bad, out.Text)
		}
	}
	if _, err := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", LegalName: testLegalName}); err == nil {
		t.Fatal("expected error without UnsubscribeURL")
	}
}

func TestRenderGreetingWithoutName(t *testing.T) {
	out, _ := Render(RenderInput{Subject: "x", BodyMarkdown: "hola", UnsubscribeURL: "https://a/b", LegalName: testLegalName})
	if !strings.Contains(out.HTML, "Hola,") {
		t.Fatalf("generic greeting missing:\n%s", out.HTML)
	}
}
