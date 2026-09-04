from pydantic import BaseModel, Field


class PullbackTrendDecisionRules(BaseModel):
    entry_rsi_max: float = Field(default=35.0, ge=0.0, le=100.0)
    exit_rsi_min: float = Field(default=70.0, ge=0.0, le=100.0)
    min_volume_ratio: float = Field(default=1.1, gt=0.0)
    hard_stop_loss_fraction: float = Field(default=0.08, gt=0.0, lt=1.0)
    max_candidates: int = Field(default=10, ge=1)
