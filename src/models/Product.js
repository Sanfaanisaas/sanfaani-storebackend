import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        slug: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        category: {
            type: String,
            trim: true,
            // Plain string for now — promote to a Category ref once catalogue
            // needs nested categories or admin-managed taxonomy.
        },
        brand: {
            type: String,
            trim: true,
        },
        images: [{ type: String, trim: true }],
        status: {
            type: String,
            enum: ["draft", "active", "archived"],
            default: "draft",
            // draft = admin is still building it, not visible on public routes
        },
    },
    { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);

export default Product;