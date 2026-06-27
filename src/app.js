import express from "express";
import path from "path";
import session from "express-session";
import nocache from "nocache";
import passport from "passport";
import { fileURLToPath } from "url";
import userRoutes from "./routes/user/userRoutes.js";
import adminRoutes from "./routes/admin/adminRouter.js";
import errorHandler from "./middlewares/errorHandler.js";
import shopRoutes from "./routes/user/listRoutes.js"
import "./passport.js"; 
import detailsRoutes from "./routes/user/detailsRoutes.js"
import cartRoutes from "./routes/user/cartRoutes.js"
import wishlistRoutes from "./routes/user/wishlistRoutes.js";
import { checkUserBlocked, attachUserLocals } from "./middlewares/userMiddleware.js";
import checkoutRoutes from "./routes/user/checkoutRouter.js"
import orderRouter from "./routes/user/orderRouter.js"
import walletRouter from "./routes/user/walletRouter.js"
import userCouponRouter from "./routes/user/couponRouter.js";
import { loadHomePage } from "./controllers/user/homeController.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(nocache());
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

app.set("view engine", "ejs");
app.set("views", path.resolve(__dirname, "views"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "electrohub_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
    console.log(`Port ${process.env.PORT} handled ${req.method} ${req.url}`);
    next();
});

app.use(passport.initialize());
app.use(passport.session());
app.use(checkUserBlocked);
app.use(attachUserLocals); //keep user detsils in every page

// Routes
app.get("/", loadHomePage)
app.use("/user", userRoutes);
app.use("/admin", adminRoutes);
app.use("/user", shopRoutes)
app.use("/user", detailsRoutes)
app.use("/user", cartRoutes)
app.use("/user", wishlistRoutes);
app.use("/user", checkoutRoutes);
app.use('/user', orderRouter);
app.use('/user', walletRouter);
app.use('/user', userCouponRouter);

app.get("/check-session", (req, res) => {
  res.json(req.session);
});

app.use((req, res) => {
  res.status(404).render("user/404notfound", { user: req.session?.user || null });
});

app.use(errorHandler);

export default app;