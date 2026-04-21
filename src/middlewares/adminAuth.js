

export function isAdminLoggedIn(req, res, next){
  if (!req.session.admin) {
   if (req.headers.accept?.includes("application/json") || req.xhr) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    return res.redirect("/admin/login");
  }
  next();
};

export function isAdminLoggedOut(req, res, next){
  if (req.session.admin) return res.redirect("/admin/dashboard");
  next();
};

