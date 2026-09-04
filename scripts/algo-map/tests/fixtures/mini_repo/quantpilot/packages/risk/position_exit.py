def hard_stop_price(entry_price, decision_rules):
    return entry_price * (1 - decision_rules.hard_stop_loss_fraction)
