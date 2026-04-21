import User from "../model/usermodel.js";

export async function isUserLoggedIn(req, res, next) {
  if (!req.session.user) {
    if (req.headers.accept?.includes("application/json") || req.xhr) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    return res.redirect("/user/login");
  }
  next();
}

export async function isLoggedOut(req, res, next) {
  if (req.session.user) return res.redirect("/user/home");
  next();
}

export async function checkUserBlocked(req, res, next) {
  if (!req.session.user) return next();

  try {
    const user = await User.findById(req.session.user._id).select("status");

    if (!user || user.status === "blocked") {
      delete req.session.user;
      req.session.save((err) => {
        if (err) console.error("Session save error during block check logout:", err);
        if (req.headers.accept?.includes("application/json") || req.xhr) {
          return res.status(403).json({
            success: false,
            blocked: true,
            message: "Your account has been blocked."
          });
        }
        return res.redirect("/user/login?blocked=true");
      });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}
