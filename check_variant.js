import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');
    
    const db = mongoose.connection.db;
    const variant = await db.collection('variants').findOne();
    console.log('Sample Variant document:', JSON.stringify(variant, null, 2));
    
    const products = await db.collection('products').find({ 
      slug: { $regex: /^(e2e-test-product|checkout-test)/ } 
    }).toArray();
    console.log('Test products found:', JSON.stringify(products.map(p => ({ _id: p._id, slug: p.slug })), null, 2));

    const testProductIds = products.map(p => p._id);
    console.log('Test product IDs:', testProductIds);

    // Insert a product
    const product = {
      name: "Test Product Resilient",
      slug: "test-product-resilient-" + Date.now(),
      description: "Test description",
      price: 100,
      category: new mongoose.Types.ObjectId(),
      status: "active",
      images: []
    };
    const prodDoc = await db.collection('products').insertOne(product);
    const productId = prodDoc.insertedId;

    // Insert a good variant
    await db.collection('variants').insertOne({
      product: productId,
      sku: "GOOD-SKU-" + Date.now(),
      attributes: { color: "blue" },
      price: 100,
      condition: "new",
      inStock: 10
    });

    // Insert a malformed variant (missing product)
    await db.collection('variants').insertOne({
      // product field missing
      sku: "BAD-SKU-" + Date.now(),
      attributes: { color: "red" },
      price: 50,
      condition: "new",
      inStock: 5
    });

    console.log('Inserted test product and variants.');
    
    // cleanup later if needed, but for now we leave it for the curl test

    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
