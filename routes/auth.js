const router = require("express").Router();
const passport = require("passport");

router.get("/discord", passport.authenticate("discord"));
router.get("/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/profile")
);

router.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

module.exports = router;
