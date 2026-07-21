import mongoose from "mongoose";

const variantSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
            index: true,
        },
        sku: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
        },
        attributes: {
            // e.g. { color: "Black", storage: "128GB" } — flexible per product type
            type: Map,
            of: String,
            default: {},
        },
        price: {
            type: Number,
            required: true,
            min: 0,
        },
        costPrice: {
            type: Number,
            min: 0,
            // internal only — never returned on public routes
        },
        supplier: {
            name: { type: String, trim: true },
            contact: { type: String, trim: true },
            // internal only — never returned on public routes
        },
        in_stock: {
            type: Boolean,
            default: false,
        },
        stockQuantity: {
            type: Number,
            min: 0,
            // required only when in_stock is true — enforced below, not here,
            // since "required" can't be conditional on a sibling field declaratively
        },
        sourcing: {
            type: Boolean,
            default: false,
        },
        sourcingLeadTimeDays: {
            type: Number,
            min: 0,
            // required only when sourcing is true — same reasoning as above
        },
    },
    { timestamps: true }
);

// The mutual-exclusion rule lives here, not in the controller, so it's
// enforced no matter what creates or updates a Variant — controller,
// seed script, admin import, migration, whatever calls .save() or
// runs validators.
variantSchema.pre("validate", function (next) {
    if (this.in_stock === this.sourcing) {
        // catches both-true AND both-false — a variant must resolve to
        // exactly one fulfilment mode
        return next(
            new Error(
                "Variant must be exactly one of in_stock or sourcing, never both or neither."
            )
        );
    }

    if (this.in_stock && (this.stockQuantity === undefined || this.stockQuantity === null)) {
        return next(new Error("in_stock variants require a stockQuantity."));
    }

    if (this.sourcing && (this.sourcingLeadTimeDays === undefined || this.sourcingLeadTimeDays === null)) {
        return next(new Error("sourcing variants require a sourcingLeadTimeDays."));
    }

    next();
});

variantSchema.methods.toPublicObject = function () {
    return {
        id: this._id,
        product: this.product,
        sku: this.sku,
        attributes: this.attributes,
        price: this.price,
        in_stock: this.in_stock,
        stockQuantity: this.in_stock ? this.stockQuantity : undefined,
        sourcing: this.sourcing,
        sourcingLeadTimeDays: this.sourcing ? this.sourcingLeadTimeDays : undefined,
        // costPrice and supplier deliberately omitted
    };
};

const Variant = mongoose.model("Variant", variantSchema);

export default Variant;