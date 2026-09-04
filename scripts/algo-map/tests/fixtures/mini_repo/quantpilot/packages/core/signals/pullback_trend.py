def evaluate_pullback_signal(request, parameters):
    rules = parameters.decision_rules
    if request.volume_ratio < rules.min_volume_ratio:
        return _decision(
            action=SignalAction.blocked,
            reason_codes=["volume_too_low"],
            reason="Volume confirmation is missing",
        )
    elif request.rsi >= rules.exit_rsi_min:
        return _decision(
            action=SignalAction.exit,
            reason_codes=exit_reason_codes,
            reason="RSI exit threshold reached",
        )
    if request.rsi <= rules.entry_rsi_max:
        return _decision(
            action=SignalAction.buy_ready,
            reason_codes=["pullback_ready", "volume_confirmed"],
            reason="Pullback entry is ready",
        )
