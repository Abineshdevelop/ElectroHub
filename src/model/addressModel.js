import mongoose from "mongoose"

const addressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    firstName: {
      type: String,
      required: true,
      trim: true
    },

    lastName: {
      type: String,
      required: true,
      trim: true
    },

    phone: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },

    address: {
      type: String,
      required: true,
      trim: true
    },

    street: {
      type: String,
      required: true,
      trim: true
    },

    state: {
      type: String,
      required: true,
      trim: true
    },

    country: {
      type: String,
      required: true,
      trim: true
    },

    pincode: {
      type: String, 
      required: true
    },

    isDefault: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

const Address = mongoose.models.Address || mongoose.model("Address", addressSchema);

export default Address