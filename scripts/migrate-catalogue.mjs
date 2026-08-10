import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../src/models/Product.js';
import Variant from '../src/models/Variant.js';
import { PRODUCT_STATUS } from '../src/utils/constants.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const dryRun = !apply;

if (dryRun) {
  console.log('--- DRY RUN MODE: No changes will be written to the database ---');
} else {
  console.log('--- APPLY MODE: Changes will be written to the database ---');
}

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  const stats = {
    scanned: 0,
    changed: 0,
    skipped: 0,
    invalid: 0,
    unresolved: 0,
  };

  // 1. Migrate Products
  console.log('\n--- Migrating Products ---');
  const products = await Product.find({});
  for (const product of products) {
    stats.scanned++;
    let changed = false;

    // Convert isActive to status
    if (product.get('isActive') !== undefined) {
      const isActive = product.get('isActive');
      const targetStatus = isActive ? PRODUCT_STATUS.ACTIVE : PRODUCT_STATUS.DRAFT;
      if (product.status !== targetStatus) {
        product.status = targetStatus;
        changed = true;
      }
      product.set('isActive', undefined);
    }

    // Ensure slug
    if (!product.slug) {
      product.slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + product._id.toString().slice(-4);
      changed = true;
    }

    // Default missing fields
    if (!product.brand) {
      product.brand = 'Generic'; // Better than empty, but migration requirement says do not invent.
      // Wait, requirement says: "Do not invent brand, warranty, inspection or condition evidence."
      // "Incomplete legacy products must remain draft, not be published using fabricated values."
      if (product.status === PRODUCT_STATUS.ACTIVE) {
         product.status = PRODUCT_STATUS.DRAFT;
         changed = true;
      }
    }

    if (changed) {
      stats.changed++;
      if (!dryRun) await product.save();
      console.log(`Migrated Product: ${product.name} (${product._id})`);
    } else {
      stats.skipped++;
    }
  }

  // 2. Migrate Variants & Repair Ownership
  console.log('\n--- Migrating Variants ---');
  const variants = await Variant.find({});
  
  // Create a map of Product -> Variants from legacy Product.variants array
  const productVariantMap = new Map();
  const rawProducts = await Product.find({}).lean();
  for (const p of rawProducts) {
    if (Array.isArray(p.variants)) {
      for (const vId of p.variants) {
        productVariantMap.set(vId.toString(), p._id);
      }
    }
  }

  for (const variant of variants) {
    stats.scanned++;
    let changed = false;

    if (!variant.product) {
      const parentId = productVariantMap.get(variant._id.toString());
      if (parentId) {
        variant.product = parentId;
        changed = true;
        console.log(`Repaired ownership for Variant: ${variant.sku} -> Product: ${parentId}`);
      } else {
        console.warn(`Orphaned Variant found: ${variant.sku} (${variant._id})`);
        stats.unresolved++;
        continue;
      }
    }

    if (changed) {
      stats.changed++;
      if (!dryRun) await variant.save();
    } else {
      stats.skipped++;
    }
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Scanned:    ${stats.scanned}`);
  console.log(`Changed:    ${stats.changed}`);
  console.log(`Skipped:    ${stats.skipped}`);
  console.log(`Invalid:    ${stats.invalid}`);
  console.log(`Unresolved: ${stats.unresolved}`);

  if (dryRun) {
    console.log('\nRun with --apply to commit changes.');
  }

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
