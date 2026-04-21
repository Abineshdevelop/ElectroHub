import mongoose from "mongoose";

const wishlistItemSchema = new mongoose.Schema({
  wishlistId: { type: mongoose.Schema.Types.ObjectId, ref: "Wishlist",  required: true },
  productId:  { type: mongoose.Schema.Types.ObjectId, ref: "Product",   required: true },
  variantId:  { type: mongoose.Schema.Types.ObjectId, ref: "Variant" },
  quantity:   { type: Number, default: 1 },
});

export default mongoose.model("WishlistItem", wishlistItemSchema);