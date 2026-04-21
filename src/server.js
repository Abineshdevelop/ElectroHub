import app from "./app.js"

const PORT = process.env.PORT || 5000;

import { connectDB } from "./db/connectDB.js";

app.get("/check-session", (req, res) => {
    console.log("Session check:", req.session);
    res.json(req.session);
});


(async () => {
    await connectDB();
    app.listen(PORT,"0.0.0.0",() => {
        console.log(`server is running on port ${PORT}`);
    });
})();
