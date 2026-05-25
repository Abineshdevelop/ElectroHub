import mongoose from "mongoose";

const suffixSchema = new mongoose.Schema({

  unit: {
    type: String,
    required: true,
    trim: true
  },

  values: [
    {
      type: String,
      trim: true
    }
  ]

}, { _id: false });


const variantOptionSchema = new mongoose.Schema({

  variantName: {
    type: String,
    required: true,
    trim: true
  },

  usesSuffix: {
    type: Boolean,
    default: false
  },

  plainValues: [
    {
      type: String,
      trim: true
    }
  ],

  suffixes: [
    suffixSchema
  ]

}, { _id: false });


const specSchema = new mongoose.Schema({

  name: {
    type: String,
    required: true,
    trim: true
  },

  required: {
    type: Boolean,
    default: false
  }

}, { _id: false });


const categorySchema = new mongoose.Schema({

  categoryName: {
    type: String,
    required: true,
    trim: true
  },

  description: {
    type: String,
    trim: true,
    default: ""
  },

  image: {
    type: String,
    default: ""
  },

  isActive: {
    type: Boolean,
    default: true
  },

  isDeleted: {
    type: Boolean,
    default: false
  },

  specificationsConfig: [
    specSchema
  ],

  variantOptions: [
    variantOptionSchema
  ]

}, { timestamps: true });


export default mongoose.models.Category || mongoose.model("Category", categorySchema);