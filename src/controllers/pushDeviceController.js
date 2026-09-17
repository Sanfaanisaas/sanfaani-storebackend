import { catchAsync } from "../utils/catchAsync.js";
import { listPushDevices, registerPushDevice, revokePushDevice } from "../services/pushDeviceService.js";

export const createPushDevice = catchAsync(async (req, res) => {
  const result = await registerPushDevice({ owner: req.user.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  return res.status(result.created ? 201 : 200).json({ success: true, data: result.device });
});
export const getPushDevices = catchAsync(async (req, res) => res.json({ success: true, data: { devices: await listPushDevices(req.user.id) } }));
export const deletePushDevice = catchAsync(async (req, res) => res.json({ success: true, data: await revokePushDevice({ owner: req.user.id, id: req.params.id }) }));
