from app.modules.decision import service
from app.modules.events import bus


def register() -> None:
    bus.subscribe("decision.assess", ["AnomalyDetected", "AnomalyEscalated", "AnomalyCorroborated"])(service.assess)
