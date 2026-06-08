import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "./model/usermodel.js";


console.log("process env ", process.env)
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error("Google OAuth credentials not configured");
}

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_AUTH_URL,
},
  
async (accessToken, refreshToken, profile, done) => {
  try {
    
    const email = profile.emails[0].value;

    // 1️⃣ Check if user already exists by email
    let user = await User.findOne({ email });

    if (user) {

      // 🔴 Blocked check
      if (user.status === "blocked") {
        return done(null, false, { message: "Your account has been blocked by the admin. Please contact support for assistance." });
      }

      // If exists but no googleId → link it
      if (!user.googleId) {
        user.googleId = profile.id;
        user.authType = "google";
        await user.save();
      }

    } else {
      // 2️⃣ Create new user
      user = await User.create({
        firstName: profile.name.givenName,
        lastName: profile.name.familyName,
        email,
        googleId: profile.id,
        authType: "google",
        status: "active"
      });
    }

    return done(null, user);

  } catch (err) {
    return done(err, null);
  }
}));


passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

export default passport;