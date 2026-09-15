import * as inventoryService from "../services/inventoryService.js";
import { catchAsync } from "../utils/catchAsync.js";

const id = (value) => value?.toString?.() || value;
const ledgerDto = (ledger) => ({
  id: id(ledger._id),
  variantId: id(ledger.variant),
  inventoryUnitId: ledger.inventoryUnit ? id(ledger.inventoryUnit) : null,
  delta: ledger.delta,
  reason: ledger.reason,
  resultingStock: ledger.resultingStock,
  fromLocationId: ledger.fromLocation ? id(ledger.fromLocation) : null,
  toLocationId: ledger.toLocation ? id(ledger.toLocation) : null,
  createdAt: ledger.createdAt,
});
const unitDto = (unit) => ({
  id: id(unit._id),
  variantId: id(unit.variant),
  serialNumber: unit.serialNumber,
  locationId: id(unit.location),
  condition: unit.condition,
  inspectionState: unit.inspectionState,
  state: unit.state,
  updatedAt: unit.updatedAt,
});
const countDto = (count) => ({
  id: id(count._id),
  variantId: id(count.variant),
  locationId: id(count.location),
  expectedQuantity: count.expectedQuantity,
  countedQuantity: count.countedQuantity,
  status: count.status,
  countScope: count.countScope,
  reason: count.reason,
  evidenceId: id(count.evidence),
  discrepancyId: count.discrepancy ? id(count.discrepancy) : null,
  createdAt: count.createdAt,
});
const discrepancyDto = (item) => ({
  id: id(item._id),
  stockCountId: id(item.stockCount),
  variantId: id(item.variant),
  locationId: id(item.location),
  expectedQuantity: item.expectedQuantity,
  countedQuantity: item.countedQuantity,
  variance: item.variance,
  status: item.status,
  resolution: item.resolution,
  resolutionReason: item.resolutionReason,
  resolutionEvidenceId: item.resolutionEvidence ? id(item.resolutionEvidence) : null,
  resolvedAt: item.resolvedAt,
  createdAt: item.createdAt,
});

export const recordManualStockMovement = catchAsync(async (req, res) => {
  const result = await inventoryService.adjustStock({ ...req.body, actor: req.user.id });
  res.status(result.replayed ? 200 : 201).json({
    success: true,
    data: { ledger: ledgerDto(result.ledger), replayed: result.replayed },
  });
});

const transition = (action) => catchAsync(async (req, res) => {
  const result = await inventoryService.transitionInventoryUnit({
    unitId: req.params.id,
    action,
    actor: req.user.id,
    ...req.body,
  });
  res.status(result.replayed ? 200 : 201).json({
    success: true,
    data: { unit: unitDto(result.unit), ledger: ledgerDto(result.ledger), replayed: result.replayed },
  });
});
export const transferInventoryUnit = transition("transfer");
export const returnInventoryUnitToStock = transition("return-to-stock");
export const releaseQuarantinedInventoryUnit = transition("release-quarantine");

export const createStockCount = catchAsync(async (req, res) => {
  const result = await inventoryService.createStockCount({ ...req.body, actor: req.user.id });
  res.status(201).json({ success: true, data: countDto(result) });
});
export const listStockCounts = catchAsync(async (req, res) => {
  const result = await inventoryService.listStockCounts(req.query);
  res.json({ success: true, data: { ...result, items: result.items.map(countDto) } });
});
export const listStockDiscrepancies = catchAsync(async (req, res) => {
  const result = await inventoryService.listStockDiscrepancies(req.query);
  res.json({ success: true, data: { ...result, items: result.items.map(discrepancyDto) } });
});
export const resolveStockDiscrepancy = catchAsync(async (req, res) => {
  const result = await inventoryService.resolveStockDiscrepancy({
    discrepancyId: req.params.id,
    actor: req.user.id,
    ...req.body,
  });
  res.json({ success: true, data: discrepancyDto(result) });
});
