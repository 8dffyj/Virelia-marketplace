const express = require("express");
const session = require("express-session");
const passport = require("./config/passport");
const path = require("path");
require("dotenv").config();

const app = express();

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static files
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  secret: "super-secret-key",
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", require("./routes/auth"));

// Middleware to make user available in views
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

// Routes
app.get("/", (req, res) => res.render("home"));
app.get("/profile", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/");
  res.render("profile");
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
