package supportkb

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Presupuesto de chunk en CARACTERES, derivado del límite duro de e5
// (512 tokens, trunca en silencio). Para español con el tokenizer XLM-R la
// razón práctica es ~3.5 chars/token; apuntamos a ~400 tokens ⇒ ~1400 chars,
// con margen para el título que el indexer prepende al embeber.
const (
	chunkTargetChars = 1200 // tamaño objetivo al acumular párrafos
	chunkMaxChars    = 1500 // tope duro: un párrafo mayor se parte por oraciones
)

// Chunk es un fragmento listo para insertar en support.kb_chunks.
type Chunk struct {
	Ord      int
	Texto    string
	Checksum string // sha256 hex del texto
}

// ChunkBody parte el body markdown de un documento en fragmentos embebibles.
// Estrategia: secciones por heading (#..######) → dentro de cada sección se
// acumulan párrafos hasta el presupuesto; el heading de la sección se
// prepende a cada chunk para que el fragmento tenga contexto por sí solo.
func ChunkBody(body string) []Chunk {
	var texts []string
	for _, sec := range splitSections(body) {
		texts = append(texts, chunkSection(sec.heading, sec.paragraphs)...)
	}

	chunks := make([]Chunk, 0, len(texts))
	for i, t := range texts {
		sum := sha256.Sum256([]byte(t))
		chunks = append(chunks, Chunk{Ord: i, Texto: t, Checksum: hex.EncodeToString(sum[:])})
	}
	return chunks
}

type section struct {
	heading    string
	paragraphs []string
}

func splitSections(body string) []section {
	var secs []section
	cur := section{}
	flush := func() {
		if len(cur.paragraphs) > 0 {
			secs = append(secs, cur)
		}
	}
	for _, para := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n\n") {
		para = strings.TrimSpace(para)
		if para == "" {
			continue
		}
		if strings.HasPrefix(para, "#") {
			// Un heading puede venir pegado a su primer párrafo dentro del
			// mismo bloque; separamos la primera línea.
			lines := strings.SplitN(para, "\n", 2)
			flush()
			cur = section{heading: strings.TrimSpace(strings.TrimLeft(lines[0], "# "))}
			if len(lines) == 2 && strings.TrimSpace(lines[1]) != "" {
				cur.paragraphs = append(cur.paragraphs, strings.TrimSpace(lines[1]))
			}
			continue
		}
		cur.paragraphs = append(cur.paragraphs, para)
	}
	flush()
	return secs
}

func chunkSection(heading string, paragraphs []string) []string {
	prefix := ""
	if heading != "" {
		prefix = heading + "\n"
	}

	var out []string
	var buf strings.Builder
	emit := func() {
		if buf.Len() > 0 {
			out = append(out, prefix+strings.TrimSpace(buf.String()))
			buf.Reset()
		}
	}

	for _, p := range paragraphs {
		// Párrafo gigante: partirlo por oraciones antes de acumular.
		for _, piece := range splitLong(p) {
			if buf.Len() > 0 && buf.Len()+len(piece) > chunkTargetChars {
				emit()
			}
			if buf.Len() > 0 {
				buf.WriteString("\n\n")
			}
			buf.WriteString(piece)
		}
	}
	emit()
	return out
}

// splitLong parte un párrafo que excede el tope duro en trozos por oración
// (". "). Si una "oración" sola excede el tope (texto sin puntuación), se
// corta en seco por chars — mejor un corte feo que truncamiento silencioso
// del modelo.
func splitLong(p string) []string {
	if len(p) <= chunkMaxChars {
		return []string{p}
	}
	var pieces []string
	var buf strings.Builder
	for _, sent := range strings.SplitAfter(p, ". ") {
		for len(sent) > chunkMaxChars {
			pieces = append(pieces, sent[:chunkMaxChars])
			sent = sent[chunkMaxChars:]
		}
		if buf.Len()+len(sent) > chunkMaxChars {
			pieces = append(pieces, strings.TrimSpace(buf.String()))
			buf.Reset()
		}
		buf.WriteString(sent)
	}
	if s := strings.TrimSpace(buf.String()); s != "" {
		pieces = append(pieces, s)
	}
	return pieces
}
