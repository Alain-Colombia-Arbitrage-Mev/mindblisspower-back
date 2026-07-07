package networkintel

type AnalysisRequest struct {
	AffiliateID  string         `json:"affiliate_id,omitempty"`
	GeneratedAt  string         `json:"generated_at,omitempty"`
	Metrics      NetworkMetrics `json:"metrics"`
	RecentEvents []NetworkEvent `json:"recent_events,omitempty"`
}

type NetworkMetrics struct {
	TotalMembers      int     `json:"total_members"`
	ActiveMembers     int     `json:"active_members"`
	LeftMembers       int     `json:"left_members"`
	RightMembers      int     `json:"right_members"`
	LeftVolume        float64 `json:"left_volume"`
	RightVolume       float64 `json:"right_volume"`
	CompanyFund       float64 `json:"company_fund"`
	ProjectedOutflows float64 `json:"projected_outflows"`
	WorstTheta          float64 `json:"worst_theta"`
	Rank                string  `json:"rank,omitempty"`
	RankLiabilityRatio  float64 `json:"rank_liability_ratio,omitempty"`
}

type NetworkEvent struct {
	Type     string  `json:"type"`
	Side     string  `json:"side,omitempty"`
	Amount   float64 `json:"amount,omitempty"`
	MemberID string  `json:"member_id,omitempty"`
	Occurred string  `json:"occurred,omitempty"`
	Notes    string  `json:"notes,omitempty"`
}

type AnalysisResponse struct {
	Provider    string       `json:"provider"`
	Model       string       `json:"model,omitempty"`
	Mode        string       `json:"mode"`
	HealthScore int          `json:"health_score"`
	RiskLevel   string       `json:"risk_level"`
	WeakLeg     string       `json:"weak_leg"`
	Summary     string       `json:"summary"`
	Predictions []Prediction `json:"predictions"`
	Findings    []Finding    `json:"findings"`
	Actions     []Action     `json:"actions"`
	Warnings    []string     `json:"warnings,omitempty"`
	Usage       *TokenUsage  `json:"usage,omitempty"`
}

type Prediction struct {
	Label     string  `json:"label"`
	Horizon   string  `json:"horizon"`
	Direction string  `json:"direction"`
	Score     float64 `json:"score"`
	Reason    string  `json:"reason"`
}

type Finding struct {
	Severity string `json:"severity"`
	Area     string `json:"area"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
}

type Action struct {
	Priority string `json:"priority"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Target   string `json:"target,omitempty"`
}

type TokenUsage struct {
	PromptTokens     int     `json:"prompt_tokens,omitempty"`
	CompletionTokens int     `json:"completion_tokens,omitempty"`
	TotalTokens      int     `json:"total_tokens,omitempty"`
	Cost             float64 `json:"cost,omitempty"`
}
