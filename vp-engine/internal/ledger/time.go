package ledger

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// tsPB convierte time.Time a *timestamppb.Timestamp. Inlined helper para no
// pegar el import cada vez que necesitamos serializar fechas en responses.
func tsPB(t time.Time) *timestamppb.Timestamp {
	return timestamppb.New(t)
}
