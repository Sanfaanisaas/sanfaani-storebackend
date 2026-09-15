import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["APPLY"], required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    backupReference: { type: String, required: true, trim: true, maxlength: 300 },
    rollbackReference: { type: String, required: true, trim: true, maxlength: 300 },
    inspectedCount: { type: Number, required: true, min: 0 },
    openingEntriesCreated: { type: Number, required: true, min: 0 },
    duplicatesFound: { type: Number, required: true, min: 0 },
    reconstructionMatched: { type: Number, required: true, min: 0 },
    reconstructionMismatched: { type: Number, required: true, min: 0 },
    completedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

schema.pre("save", function () {
  if (!this.isNew) throw new Error("Inventory migration evidence is immutable");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"])
  schema.pre(operation, function () {
    throw new Error("Inventory migration evidence is immutable");
  });

export default mongoose.model("InventoryMigrationRun", schema);
