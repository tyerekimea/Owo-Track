function errorHandler(err, _req, res, _next) {
  console.error(err);

  if (err?.name === "MulterError") {
    return res.status(400).json({ error: err.message });
  }

  if (err?.message === "Unsupported file type") {
    return res.status(400).json({ error: "Unsupported file type." });
  }

  return res.status(err?.statusCode || 500).json({
    error: err?.expose ? err.message : "An unexpected server error occurred.",
  });
}

module.exports = { errorHandler };
