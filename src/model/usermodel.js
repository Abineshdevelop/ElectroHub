import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    phone: {
      type: String,
      required: function () {
        return this.authType === "local";
      },
      unique: true,
      sparse: true,
      trim: true
    },

    password: {
      type: String,
      required: function () {
        return this.authType === "local";
      }
    },

    profileImage: { type: String, default: null },

    status: {
      type: String,
      enum: ["pending", "active", "blocked"],
      default: "pending",
      index: true   // keep (single index here is fine)
    },

    authType: {
      type: String,
      enum: ["local", "google"],
      default: "local",
      index: true
    },

    emailChangeOtp: {
      type: String,
      default: null
    },
    emailChangeOtpExpires: {
      type: Date,
      default: null
    },
    emailChangeOtpAttempts: {
      type: Number,
      default: 0
    },
    pendingEmail: {
      type: String,
      default: null
    },
    passwordChangeOtp: { type: String, default: null },
    passwordChangeOtpExpires: { type: Date, default: null },
    passwordChangeOtpAttempts: { type: Number, default: 0 },
    pendingPassword: { type: String, default: null },

    isAdmin: {
      type: Boolean,
      default: false,
      index: true
    },
    otpAttempts: {
      type: Number,
      default: 0
    },
    otpResendCount: {
      type: Number,
      default: 0
    },
    otpLockedUntil: {
      type: Date,
      default: null
    },

    otp: String,
    otpExpiresAt: Date,

    deletedAt: { type: Date, default: null },
    referralToken: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    isReferralUsed: {
      type: Boolean,
      default: false
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

// Indexes for admin search (ONLY here, not in fields)
userSchema.index({ firstName: 1 });
userSchema.index({ lastName: 1 });

// // Prevent blocking admins
// userSchema.pre("save", async function () {
//   if (!this.password || !this.isModified("password")) return;

//   this.password = await bcrypt.hash(this.password, 10);
// });

const User = mongoose.models.User || mongoose.model("User", userSchema);


export default User