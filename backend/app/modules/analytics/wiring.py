from app.modules.analytics import service
from app.modules.events import bus


def register() -> None:
    bus.subscribe("analytics.evaluate", ["WorkOrderClosed"])(service.record_evaluation)
