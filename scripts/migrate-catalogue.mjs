import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Product from "../src/models/Product.js";
import Variant from "../src/models/Variant.js";
import {
  normalizeSlug,
  validatePublicationCandidate,
} from "../src/services/catalogueValidationService.js";
import { PRODUCT_STATUS } from "../src/utils/constants.js";

const emptyStats = () => ({
  scanned: 0,
  changed: 0,
  skipped: 0,
  invalid: 0,
  unresolved: 0,
});

const asId = (value) => value?.toString?.() ?? String(value ?? "");
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const normalizeMapping = (mapping) => {
  if (mapping instanceof Map) return new Map(mapping);
  if (mapping && typeof mapping === "object") return new Map(Object.entries(mapping));
  return new Map();
};

const addToSetMap = (map, key, value) => {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
};

const updateDocument = (set, unset) => ({
  ...(Object.keys(set).length > 0 ? { $set: set } : {}),
  ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
});

export class CatalogueMigrator {
  constructor({
    apply = false,
    orphanMapping,
    ProductModel = Product,
    VariantModel = Variant,
    logger = console,
  } = {}) {
    this.apply = apply === true;
    this.orphanMapping = normalizeMapping(orphanMapping);
    this.ProductModel = ProductModel;
    this.VariantModel = VariantModel;
    this.logger = logger;
    this.stats = emptyStats();
    this.issues = [];
  }

  addIssue(type, details) {
    this.issues.push({ type, ...details });
    this.stats.unresolved += 1;
  }

  allocateSlugs(products) {
    const assignments = new Map();
    const used = new Set();
    const ordered = [...products].sort((left, right) => {
      const leftNormalized = normalizeSlug(left.slug);
      const rightNormalized = normalizeSlug(right.slug);
      const leftPriority = left.slug === leftNormalized && leftNormalized ? 0 : 1;
      const rightPriority = right.slug === rightNormalized && rightNormalized ? 0 : 1;
      return leftPriority - rightPriority || asId(left._id).localeCompare(asId(right._id));
    });

    for (const product of ordered) {
      const id = asId(product._id);
      const base = normalizeSlug(product.slug)
        || normalizeSlug(product.name)
        || `product-${id}`;
      let candidate = base;

      if (used.has(candidate)) candidate = `${base}-${id.slice(-8)}`;
      let collision = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${id.slice(-8)}-${collision}`;
        collision += 1;
      }

      used.add(candidate);
      assignments.set(id, candidate);
    }

    return assignments;
  }

  async buildPlan() {
    const [products, variants] = await Promise.all([
      this.ProductModel.collection.find({}).sort({ _id: 1 }).toArray(),
      this.VariantModel.collection.find({}).sort({ _id: 1 }).toArray(),
    ]);
    this.stats.scanned = products.length + variants.length;

    const productById = new Map(products.map((product) => [asId(product._id), product]));
    const variantById = new Map(variants.map((variant) => [asId(variant._id), variant]));
    const referenceOwners = new Map();
    const unsafeProductIds = new Set();

    for (const product of products) {
      if (!Array.isArray(product.variants)) continue;

      for (const variantIdValue of product.variants) {
        const variantId = asId(variantIdValue);
        if (!variantById.has(variantId)) {
          this.addIssue("missing_variant_reference", {
            productId: asId(product._id),
            variantId,
          });
          unsafeProductIds.add(asId(product._id));
          continue;
        }
        addToSetMap(referenceOwners, variantId, asId(product._id));
      }
    }

    const plannedVariantOwners = new Map();
    const variantUpdates = [];

    for (const variant of variants) {
      const variantId = asId(variant._id);
      const legacyOwners = referenceOwners.get(variantId) ?? new Set();
      const currentOwner = variant.product ? asId(variant.product) : "";
      let desiredOwner = currentOwner;

      if (legacyOwners.size > 1) {
        const productIds = [...legacyOwners].sort();
        this.addIssue("duplicate_variant_ownership", { variantId, productIds });
        productIds.forEach((productId) => unsafeProductIds.add(productId));
        desiredOwner = currentOwner;
      } else if (currentOwner && !productById.has(currentOwner)) {
        this.addIssue("missing_product_reference", {
          variantId,
          productId: currentOwner,
        });
        desiredOwner = currentOwner;
      } else if (currentOwner && legacyOwners.size === 1
          && !legacyOwners.has(currentOwner)) {
        const [legacyOwner] = legacyOwners;
        this.addIssue("conflicting_variant_ownership", {
          variantId,
          productIds: [currentOwner, legacyOwner].sort(),
        });
        unsafeProductIds.add(currentOwner);
        unsafeProductIds.add(legacyOwner);
      } else if (!currentOwner && legacyOwners.size === 1) {
        [desiredOwner] = legacyOwners;
      } else if (!currentOwner && legacyOwners.size === 0) {
        const mappedOwner = asId(this.orphanMapping.get(variantId));
        if (mappedOwner && productById.has(mappedOwner)) {
          desiredOwner = mappedOwner;
        } else if (mappedOwner) {
          this.addIssue("invalid_orphan_mapping", {
            variantId,
            productId: mappedOwner,
          });
        } else {
          this.addIssue("orphan_variant", { variantId });
        }
      }

      plannedVariantOwners.set(variantId, desiredOwner);
      if (desiredOwner && desiredOwner !== currentOwner
          && legacyOwners.size <= 1) {
        variantUpdates.push({
          collection: this.VariantModel.collection,
          filter: { _id: variant._id },
          update: { $set: { product: productById.get(desiredOwner)._id } },
          kind: "variant",
          id: variantId,
        });
      }
    }

    const slugAssignments = this.allocateSlugs(products);
    const productUpdates = [];
    const invalidProductIds = new Set();

    for (const product of products) {
      const productId = asId(product._id);
      const set = {};
      const unset = {};
      const slug = slugAssignments.get(productId);
      const requestedStatus = hasOwn(product, "isActive")
        ? (product.isActive === true ? PRODUCT_STATUS.ACTIVE : PRODUCT_STATUS.DRAFT)
        : product.status;
      let status = Object.values(PRODUCT_STATUS).includes(requestedStatus)
        ? requestedStatus
        : PRODUCT_STATUS.DRAFT;

      if (requestedStatus && !Object.values(PRODUCT_STATUS).includes(requestedStatus)) {
        invalidProductIds.add(productId);
      }
      if (hasOwn(product, "isActive") && typeof product.isActive !== "boolean") {
        invalidProductIds.add(productId);
      }

      const candidateProduct = { ...product, slug, status };
      const ownedVariants = variants
        .filter((variant) => plannedVariantOwners.get(asId(variant._id)) === productId)
        .map((variant) => ({ ...variant, product: product._id }));

      if (status === PRODUCT_STATUS.ACTIVE) {
        const missing = await validatePublicationCandidate({
          product: candidateProduct,
          variants: ownedVariants,
          isSlugUnique: async () => true,
        });
        if (missing.length > 0 || unsafeProductIds.has(productId)) {
          status = PRODUCT_STATUS.DRAFT;
          invalidProductIds.add(productId);
        }
      }

      if (product.slug !== slug) set.slug = slug;
      if (product.status !== status) set.status = status;
      if (hasOwn(product, "isActive")) unset.isActive = "";

      const update = updateDocument(set, unset);
      if (Object.keys(update).length > 0) {
        productUpdates.push({
          collection: this.ProductModel.collection,
          filter: { _id: product._id },
          update,
          kind: "product",
          id: productId,
        });
      }
    }

    this.stats.invalid = invalidProductIds.size;
    const operations = [...productUpdates, ...variantUpdates];
    this.stats.changed = operations.length;
    this.stats.skipped = this.stats.scanned - this.stats.changed;
    return operations;
  }

  async run() {
    this.stats = emptyStats();
    this.issues = [];
    this.logger.log(this.apply
      ? "--- APPLY MODE: catalogue changes enabled ---"
      : "--- DRY RUN MODE: zero writes ---");

    const operations = await this.buildPlan();
    if (this.apply) {
      for (const operation of operations) {
        await operation.collection.updateOne(operation.filter, operation.update);
      }
    }

    this.report();
    return { ...this.stats };
  }

  report() {
    this.logger.log("--- Migration Summary ---");
    this.logger.log(`Scanned:    ${this.stats.scanned}`);
    this.logger.log(`Changed:    ${this.stats.changed}`);
    this.logger.log(`Skipped:    ${this.stats.skipped}`);
    this.logger.log(`Invalid:    ${this.stats.invalid}`);
    this.logger.log(`Unresolved: ${this.stats.unresolved}`);
    for (const issue of this.issues) this.logger.warn(JSON.stringify(issue));
  }
}

export const loadReviewedOrphanMapping = async (mappingPath) => {
  const contents = JSON.parse(await readFile(mappingPath, "utf8"));
  if (contents?.reviewed !== true || !contents.mappings
      || typeof contents.mappings !== "object" || Array.isArray(contents.mappings)) {
    throw new Error("Orphan mapping must contain reviewed=true and a mappings object");
  }
  return new Map(Object.entries(contents.mappings));
};

const argumentValue = (name) => {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const runFromCommandLine = async () => {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  const mappingPath = argumentValue("--orphan-map");
  const orphanMapping = mappingPath
    ? await loadReviewedOrphanMapping(resolve(mappingPath))
    : new Map();

  try {
    await mongoose.connect(process.env.MONGO_URI);
    const migrator = new CatalogueMigrator({
      apply: process.argv.includes("--apply"),
      orphanMapping,
    });
    await migrator.run();
  } finally {
    await mongoose.disconnect();
  }
};

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runFromCommandLine().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
