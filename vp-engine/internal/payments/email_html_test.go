package payments

import (
	"testing"
)

func TestBuildSESHTMLInput(t *testing.T) {
	in := buildSESHTMLInput("Mindbliss Power <no-reply@mindblisspower.com>", HTMLEmail{
		To: "ana@example.com", Subject: "Hola", HTML: "<p>x</p>", Text: "x",
		ReplyTo: "soporte@mindblisspower.com", ConfigSet: "entregas",
		UnsubscribeURL: "https://app.mindblisspower.com/baja?t=abc",
	})
	if *in.FromEmailAddress != "Mindbliss Power <no-reply@mindblisspower.com>" {
		t.Fatalf("from = %s", *in.FromEmailAddress)
	}
	if len(in.Destination.ToAddresses) != 1 || in.Destination.ToAddresses[0] != "ana@example.com" || len(in.Destination.BccAddresses) != 0 {
		t.Fatalf("destination = %+v", in.Destination)
	}
	if *in.ConfigurationSetName != "entregas" || in.ReplyToAddresses[0] != "soporte@mindblisspower.com" {
		t.Fatalf("configset/replyto wrong")
	}
	simple := in.Content.Simple
	if *simple.Body.Html.Data != "<p>x</p>" || *simple.Body.Text.Data != "x" {
		t.Fatalf("body wrong")
	}
	var lu, lup string
	for _, h := range simple.Headers {
		switch *h.Name {
		case "List-Unsubscribe":
			lu = *h.Value
		case "List-Unsubscribe-Post":
			lup = *h.Value
		}
	}
	if lu != "<https://app.mindblisspower.com/baja?t=abc>" || lup != "List-Unsubscribe=One-Click" {
		t.Fatalf("list-unsubscribe headers = %q / %q", lu, lup)
	}
}

func TestBuildSESHTMLInputWithoutOptionals(t *testing.T) {
	in := buildSESHTMLInput("a <a@b.c>", HTMLEmail{To: "x@y.z", Subject: "s", HTML: "<p/>", Text: "t"})
	if in.ConfigurationSetName != nil || len(in.ReplyToAddresses) != 0 || len(in.Content.Simple.Headers) != 0 {
		t.Fatalf("optionals should be absent: %+v", in)
	}
}
