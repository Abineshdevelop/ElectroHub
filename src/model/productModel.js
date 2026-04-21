import mongoose from "mongoose";

const variantSchema = new mongoose.Schema({
  options: { type: Map, of: String, default: {} },  // dynamic: { RAM: "8GB", Color: "Red" }
  price:   { type: Number, default: 0 },
  mrp:     { type: Number, default: 0 },
  stock:   { type: Number, default: 0 },
  images:  [{ type: String }],
}, { _id: false });

const productSchema = new mongoose.Schema({
  categoryId:     { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
  productName:    { type: String, required: true, trim: true },
  brandName:      { type: String, trim: true, default: "" },
  description:    { type: String, trim: true, default: "" },
  isActive:       { type: Boolean, default: true },
  isDeleted:      { type: Boolean, default: false },
  specifications: { type: Map, of: String, default: {} },  // { "Processor": "i7", "Battery": "72Wh" }
  variants:       [variantSchema],
}, { timestamps: true });//vrient referande

export default mongoose.model("Product", productSchema);