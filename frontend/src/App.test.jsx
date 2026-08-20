import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

const API_URL = "http://localhost:4000";

function jsonResponse(body, { ok = true, status = ok ? 200 : 400 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const EMPTY_SUMMARY = {
  totalsByCategory: {},
  grandTotal: 0,
  count: 0,
  month: "2026-01",
  monthSpentByCategory: {},
  budgets: {},
};

/**
 * Builds a fetch mock that answers the small set of endpoints App.jsx
 * calls, based on URL + method. `overrides` lets individual tests swap in
 * a different response for a specific call (e.g. a failed login).
 */
function mockFetch(overrides = {}) {
  return vi.fn((url, options = {}) => {
    const method = options.method || "GET";
    const key = `${method} ${url.replace(API_URL, "")}`;

    if (overrides[key]) {
      return Promise.resolve(overrides[key]());
    }

    if (key === "GET /api/auth/me") {
      return Promise.resolve(jsonResponse({}, { ok: false, status: 401 }));
    }
    if (key.startsWith("GET /api/categories")) {
      return Promise.resolve(jsonResponse(["Rent", "Utilities"]));
    }
    if (key.startsWith("GET /api/expenses")) {
      return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }));
    }
    if (key.startsWith("GET /api/summary")) {
      return Promise.resolve(jsonResponse(EMPTY_SUMMARY));
    }

    throw new Error(`Unhandled fetch in test: ${key}`);
  });
}

beforeEach(() => {
  global.fetch = mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App auth flow", () => {
  it("shows the login screen when there is no active session", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Owo Track" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("switches to the registration form and shows the full name field", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("logs in successfully and shows the dashboard with the user's name", async () => {
    global.fetch = mockFetch({
      "POST /api/auth/login": () =>
        jsonResponse({ user: { id: "u1", name: "Ada Lovelace", email: "ada@owo.com" } }),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText(/Welcome, Ada Lovelace/)).toBeInTheDocument();

    // The login request should carry the httpOnly session cookie exchange,
    // not a token in the body — credentials: 'include' is what makes that work.
    const loginCall = global.fetch.mock.calls.find(([url]) => url === `${API_URL}/api/auth/login`);
    expect(loginCall[1].credentials).toBe("include");
  });

  it("shows an error message when login fails", async () => {
    global.fetch = mockFetch({
      "POST /api/auth/login": () => jsonResponse({ error: "Invalid email or password." }, { ok: false, status: 401 }),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("logs out and returns to the login screen", async () => {
    global.fetch = mockFetch({
      "POST /api/auth/login": () =>
        jsonResponse({ user: { id: "u1", name: "Ada Lovelace", email: "ada@owo.com" } }),
      "POST /api/auth/logout": () => ({ ok: true, status: 204, json: async () => null }),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByText(/Welcome, Ada Lovelace/);

    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome, Ada Lovelace/)).not.toBeInTheDocument();
  });
});
