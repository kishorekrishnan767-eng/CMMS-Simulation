from app.modules.cmms import service
from app.modules.simulation import engine


def register() -> None:
    engine.add_tick_hook(service.on_tick)
