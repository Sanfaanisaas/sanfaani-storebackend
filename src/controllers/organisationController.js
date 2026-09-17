import { catchAsync } from "../utils/catchAsync.js";
import * as organisations from "../services/organisationService.js";

export const createOrganisation = catchAsync(async (req, res) => {
  const result = await organisations.createOrganisation({
    actor: req.user.id,
    input: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  res.status(result.replayed ? 200 : 201).json({ success: true, data: result.organisation });
});

export const listMyOrganisations = catchAsync(async (req, res) => {
  res.json({ success: true, data: { organisations: await organisations.listOrganisations({ actor: req.user.id }) } });
});

export const addOrUpdateOrganisationMember = catchAsync(async (req, res) => {
  const membership = await organisations.addOrUpdateMember({
    actor: req.user.id,
    organisationId: req.params.id,
    input: req.body,
  });
  res.status(201).json({ success: true, data: membership });
});

export const listOrganisationMembers = catchAsync(async (req, res) => {
  res.json({
    success: true,
    data: { members: await organisations.listMembers({ actor: req.user.id, organisationId: req.params.id }) },
  });
});
