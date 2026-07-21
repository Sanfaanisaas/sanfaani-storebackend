// scripts/test-variant-validator.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import Product from "../models/Product.js";
import Variant from "../models/Variant.js";

dotenv.config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected. Running variant validator checks...\n");

    const product = await Product.create({
        name: "Test Product — DELETE ME",
        slug: `test-product-${Date.now()}`,
    });

    const cases = [
        { label: "1. in_stock=true, sourcing=true", expect: "reject",
            payload: { product: product._id, sku: `SKU-A-${Date.now()}`, price: 100, in_stock: true, sourcing: true, stockQuantity: 5 } },
        { label: "2. in_stock=false, sourcing=false", expect: "reject",
            payload: { product: product._id, sku: `SKU-B-${Date.now()}`, price: 100, in_stock: false, sourcing: false } },
        { label: "3. in_stock=true, no stockQuantity", expect: "reject",
            payload: { product: product._id, sku: `SKU-C-${Date.now()}`, price: 100, in_stock: true, sourcing: false } },
        { label: "4. in_stock=true, stockQuantity=12, sourcing=false", expect: "accept",
            payload: { product: product._id, sku: `SKU-D-${Date.now()}`, price: 100, in_stock: true, sourcing: false, stockQuantity: 12 } },
    ];

    const createdIds = [];
    for (const c of cases) {
        try {
            const v = await Variant.create(c.payload);
            createdIds.push(v._id);
            console.log(`${c.label} -> ${c.expect === "accept" ? "PASS (saved)" : "FAIL (saved, should've rejected)"}`);
        } catch (err) {
            console.log(`${c.label} -> ${c.expect === "reject" ? "PASS (rejected)" : "FAIL (rejected, should've saved)"}`);
            console.log(`   reason: ${err.message}`);
        }
    }

    await Variant.deleteMany({ _id: { $in: createdIds } });
    await Product.deleteOne({ _id: product._id });
    console.log("\nCleanup done.");
    await mongoose.disconnect();
}

run().catch((err) => { console.error("Script failed:", err); process.exit(1); });