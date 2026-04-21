export function showLogin (req, res){
  if (req.session.admin) {
    return res.redirect("/admin/dashboard");
  }

  res.render("admin/auth/login", { title: "Admin Login" });
};

export async function loginAdmin (req, res, next){
  try {
    const email = (req.body.email || "").trim();
    const password = (req.body.password || "").trim();
    if (!email || !password) {
      throw new AppError(400, "Email and Password Required")
    }

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res
        .status(500)
        .json({ success: false, message: "Admin credentials not configured" });
    }

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.admin = {
        email,
        role: "admin",
        loggedInAt: Date.now(),
      };

      return req.session.save((err) => {
        if (err) console.error("Session save error during admin login:", err);
        return res.json({ success: true });
      });
    }

    return res.json({ success: false, message: "Invalid admin credentials" });
  } catch (err) {
    next(err)
  }
};

export function adminDashboard (req, res){
  if (!req.session.admin) {
    return res.redirect("/admin/login");
  }

res.render("admin/auth/dashboard", {
  title: "Admin Dashboard",
  admin: req.session.admin,
});

};

export function logoutAdmin (req, res){
  delete req.session.admin;
  req.session.save((err) => {
    if (err) console.error("Session save error during admin logout:", err);
    res.redirect("/admin/login");
  });
};

export default{
  showLogin,
  loginAdmin,
  adminDashboard,
  logoutAdmin,
};

