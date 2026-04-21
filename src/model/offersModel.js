import mongoose from 'mongoose';

const offerSchema = new mongoose.Schema(
  {
    offerName: {
      type:      String,
      required:  true,
      trim:      true,
      minlength: 3,
      maxlength: 100,
    },

    offerType: {
      type: String,
      enum: ['product', 'category'],
      required: true,
    },

    refId: {
      type:     mongoose.Schema.Types.ObjectId,
      required: true,
    },

    offerPrecentage: {
      type:     Number,
      required: true,
      min:      1,
      max:      100,
    },

    startDate: {
      type:     Date,
      required: true,
    },

    endDate: {
      type:     Date,
      required: true,
    },

    isActive: {
      type:    Boolean,
      default: true,
    },

    isDeleted: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Offer = mongoose.model('Offer', offerSchema);

export default Offer;