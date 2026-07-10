package supportkb

import (
	"strings"
	"testing"
)

func TestChunkBody_RespetaTopeDuro(t *testing.T) {
	// Documento con secciones y un párrafo gigante sin puntuación:
	// NINGÚN chunk puede exceder chunkMaxChars + heading (el truncamiento
	// silencioso de e5 es el bug que este tope previene).
	long := strings.Repeat("palabra ", 600) // ~4800 chars sin ". "
	body := "# Retiros\n\nLos retiros se procesan el día 1.\n\n" + long +
		"\n\n## Requisitos\n\nKYC aprobado y wallet USD activa."

	chunks := ChunkBody(body)
	if len(chunks) < 4 {
		t.Fatalf("esperaba ≥4 chunks (párrafo gigante partido), got %d", len(chunks))
	}
	for _, c := range chunks {
		// margen: heading prepend + "\n"
		if len(c.Texto) > chunkMaxChars+100 {
			t.Errorf("chunk ord=%d excede tope: %d chars", c.Ord, len(c.Texto))
		}
		if c.Checksum == "" || len(c.Checksum) != 64 {
			t.Errorf("chunk ord=%d checksum inválido: %q", c.Ord, c.Checksum)
		}
	}
}

func TestChunkBody_HeadingDaContexto(t *testing.T) {
	body := "# Bono de puntos R3\n\nEl bono aplica al calificar.\n\n# Retiros\n\nSe pagan el día 1."
	chunks := ChunkBody(body)
	if len(chunks) != 2 {
		t.Fatalf("esperaba 2 chunks (uno por sección), got %d", len(chunks))
	}
	if !strings.HasPrefix(chunks[0].Texto, "Bono de puntos R3") {
		t.Errorf("chunk 0 sin heading de contexto: %q", chunks[0].Texto)
	}
	if !strings.HasPrefix(chunks[1].Texto, "Retiros") {
		t.Errorf("chunk 1 sin heading de contexto: %q", chunks[1].Texto)
	}
}

func TestChunkBody_OrdSecuencialYChecksumEstable(t *testing.T) {
	body := "# A\n\nuno.\n\ndos.\n\n# B\n\ntres."
	a := ChunkBody(body)
	b := ChunkBody(body)
	for i := range a {
		if a[i].Ord != i {
			t.Errorf("ord no secuencial: pos %d tiene ord %d", i, a[i].Ord)
		}
		if a[i].Checksum != b[i].Checksum {
			t.Errorf("checksum no determinístico en ord %d", i)
		}
	}
}

func TestChunkBody_AcumulaParrafosCortos(t *testing.T) {
	// Muchos párrafos cortos de la misma sección deben agruparse en un solo
	// chunk (no un embedding por línea — eso multiplicaría el costo x20).
	var sb strings.Builder
	sb.WriteString("# FAQ\n\n")
	for i := 0; i < 20; i++ {
		sb.WriteString("Pregunta corta con su respuesta breve.\n\n")
	}
	chunks := ChunkBody(sb.String())
	if len(chunks) != 1 {
		t.Fatalf("esperaba 1 chunk acumulado, got %d", len(chunks))
	}
}
