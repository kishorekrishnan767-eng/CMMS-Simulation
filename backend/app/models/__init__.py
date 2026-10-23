"""All ORM models. Importing this package registers every table on ``Base.metadata``."""
from app.models.assets import Asset, Building, Floor, Sensor
from app.models.cmms import (
    Approval,
    Evaluation,
    InspectionRecord,
    InventoryItem,
    Role,
    StockMovement,
    StockReservation,
    Technician,
    TechnicianShift,
    User,
    VerificationRecord,
    WorkOrder,
    WorkOrderEvent,
    WorkOrderPart,
)
from app.models.platform import (
    AuditLog,
    DeadLetter,
    FaultInjection,
    OutboxEvent,
    ProcessedEvent,
    SimulationRun,
    SimulationState,
)
from app.models.telemetry import (
    AnomalyEvent,
    AnomalyEvidence,
    DetectorState,
    PolicyVersion,
    RejectedTelemetry,
    RiskAssessment,
    TelemetryReading,
)

__all__ = [
    "Approval", "Asset", "AnomalyEvent", "AnomalyEvidence", "AuditLog", "Building", "DeadLetter",
    "DetectorState", "Evaluation", "FaultInjection", "Floor", "InspectionRecord", "InventoryItem",
    "OutboxEvent", "PolicyVersion", "ProcessedEvent", "RejectedTelemetry", "RiskAssessment", "Role",
    "Sensor", "SimulationRun", "SimulationState", "StockMovement", "StockReservation", "Technician",
    "TechnicianShift", "TelemetryReading", "User", "VerificationRecord", "WorkOrder", "WorkOrderEvent",
    "WorkOrderPart",
]
