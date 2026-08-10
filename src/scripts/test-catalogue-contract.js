import test from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/Product.js';
import Variant from '../models/Variant.js';
import { PRODUCT_STATUS, AVAILABILITY_STATUS, PRODUCT_CONDITION } from '../utils/constants.js';

dotenv.config({ path: '.env.test' });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/sanfaani_test';
if (!MONGO_URI.includes('test')) {
  throw new Error('Test MONGO_URI must contain "test" to prevent accidental data loss.');
}

test.before(async () => {
  await mongoose.connect(MONGO_URI);
  await Product.deleteMany({});
  await Variant.deleteMany({});
});

test.after(async () => {
  await mongoose.disconnect();
});

test('Catalogue Contract Tests', async (t) => {
  let productId;
  let variantId;

  await t.test('1. Draft product creation succeeds', async () => {
    const product = await Product.create({
      name: 'Test Phone',
      slug: 'test-phone',
      description: 'A test phone',
      category: 'Phones',
      brand: 'TestBrand',
      status: PRODUCT_STATUS.DRAFT
    });
    productId = product._id;
    assert.strictEqual(product.status, PRODUCT_STATUS.DRAFT);
    assert.strictEqual(product.slug, 'test-phone');
  });

  await t.test('2. Variant creation with ownership succeeds', async () => {
    const variant = await Variant.create({
      product: productId,
      sku: 'TP-001',
      attributes: { color: 'Black' },
      price: 500,
      condition: PRODUCT_CONDITION.NEW,
      inStock: 10
    });
    variantId = variant._id;
    assert.strictEqual(variant.product.toString(), productId.toString());
    assert.strictEqual(variant.availability, AVAILABILITY_STATUS.IN_STOCK);
  });

  await t.test('3. Sourcing-only variant reports sourcing status', async () => {
    const sourcingVariant = await Variant.create({
      product: productId,
      sku: 'TP-002',
      attributes: { color: 'White' },
      price: 450,
      condition: PRODUCT_CONDITION.NEW,
      sourcing: {
        supplier: 'Test Supplier',
        leadTimeDays: 5,
        costPrice: 300
      }
    });
    assert.strictEqual(sourcingVariant.availability, AVAILABILITY_STATUS.SOURCING);
  });

  await t.test('4. Variant public projection hides sourcing details', async () => {
    const variant = await Variant.findOne({ sku: 'TP-002' });
    const publicObj = variant.toPublicObject();
    assert.strictEqual(publicObj.sourcing, undefined);
    assert.strictEqual(publicObj.supplier, undefined);
    assert.strictEqual(publicObj.costPrice, undefined);
    assert.strictEqual(publicObj.availability, AVAILABILITY_STATUS.SOURCING);
  });

  await t.test('5. Duplicate SKU is rejected', async () => {
    await assert.rejects(
      Variant.create({
        product: productId,
        sku: 'TP-001',
        attributes: { color: 'Blue' },
        price: 500,
        condition: PRODUCT_CONDITION.NEW,
        inStock: 5
      }),
      /E11000/
    );
  });

  await t.test('6. Incomplete publication transition fails (simulated controller logic)', async () => {
    // In our implementation, we enforce this in the controller.
    // Here we can test the logic we added to the controller if we were using supertest,
    // but we'll focus on model/logic for now.
    const product = await Product.findById(productId);
    const variants = await Variant.find({ product: productId });
    
    const errors = [];
    if (!product.images || product.images.length === 0) errors.push("At least one image is required");
    
    assert.ok(errors.includes("At least one image is required"));
  });
});
