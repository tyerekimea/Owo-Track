import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked before App.jsx (and its imports) load, so the real Firebase SDK
// never initializes in the test environment — it would otherwise throw
// auth/invalid-api-key with no real VITE_FIREBASE_* credentials present.
vi.mock("./firebase", () => ({
  auth: { currentUser: null },
}));

vi.mock("firebase/auth", () => {
  let authStateCallback = null;
  return {
    onAuthStateChanged: vi.fn((authInstance, callback) => {
      authStateCallback = callback;
      callback(authInstance.currentUser);
      return () => {};
    }),
    signInWithEmailAndPassword: vi.fn(async (authInstance, email) => {
      authInstance.currentUser = {
        uid: "u1",
        email,
        getIdToken: async () => "fake-id-token",
      };
      authStateCallback?.(authInstance.currentUser);
    }),
    signOut: vi.fn(async (authInstance) => {
      authInstance.currentUser = null;
      authStateCallback?.(null);
    }),
  };
});

const { auth } = await import("./firebase");
const { signInWithEmailAndPassword } = await import("firebase/auth");
const App = (await import("./App")).default;

const API_URL = "http://localhost:4000";

function jsonResponse(body, { ok = true, status = ok ? 200 : 400 } = {}) {
  return { ok, status, json: async () => body };
}

const EMPTY_SUMMARY = {
  totalsByCategory: {},
  grandTotal: 0,
  count: 0,
  month: "2026-01",
  monthSpentByCategory: {},
  budgets: {},
};

const ADMIN_PROFILE = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@owo.com",
  organization_id: "org-1",
  team_id: "team-1",
  role: "admin",
};

const MANAGER_PROFILE = {
  id: "u1",
  name: "Grace Hopper",
  email: "grace@owo.com",
  organization_id: "org-1",
  team_id: "team-1",
  role: "manager",
};

/** Answers the endpoints App.jsx calls, based on URL + method. */
function mockFetch(overrides = {}) {
  return vi.fn((url, options = {}) => {
    const method = options.method || "GET";
    const key = `${method} ${url.replace(API_URL, "")}`;

    if (overrides[key]) return Promise.resolve(overrides[key]());

    if (key.startsWith("GET /api/auth/me")) {
      return Promise.resolve(jsonResponse({}, { ok: false, status: 401 }));
    }
    if (key.startsWith("GET /api/categories")) return Promise.resolve(jsonResponse(["Rent", "Utilities"]));
    if (key.startsWith("GET /api/expenses/pending-approval")) return Promise.resolve(jsonResponse([]));
    if (key.startsWith("GET /api/expenses")) {
      return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }));
    }
    if (key.startsWith("GET /api/summary")) return Promise.resolve(jsonResponse(EMPTY_SUMMARY));
    if (key.startsWith("GET /api/users")) return Promise.resolve(jsonResponse([]));
    if (key.startsWith("GET /api/teams")) return Promise.resolve(jsonResponse([]));
    if (key === "POST /api/auth/logout") return Promise.resolve({ ok: true, status: 204, json: async () => null });

    throw new Error(`Unhandled fetch in test: ${key}`);
  });
}

beforeEach(() => {
  auth.currentUser = null;
  global.fetch = mockFetch();
});

afterEach(() => {
  vi.clearAllMocks();
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
      "GET /api/auth/me": () => jsonResponse({ user: ADMIN_PROFILE }),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText(/Welcome, Ada Lovelace/)).toBeInTheDocument();
    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(auth, "ada@owo.com", "password123");
  });

  it("registers a new account, creating it on the backend then signing in client-side", async () => {
    global.fetch = mockFetch({
      "POST /api/auth/register": () => jsonResponse({ ok: true }, { status: 201 }),
      "GET /api/auth/me": () => jsonResponse({ user: ADMIN_PROFILE }),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.click(screen.getByRole("button", { name: "Register" }));
    await user.type(screen.getByLabelText("Full name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/Welcome, Ada Lovelace/)).toBeInTheDocument();

    const registerCall = global.fetch.mock.calls.find(([url]) => url === `${API_URL}/api/auth/register`);
    expect(registerCall).toBeTruthy();
    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(auth, "ada@owo.com", "password123");
  });

  it("shows a manager their team as a read-only list", async () => {
    global.fetch = mockFetch({
      "GET /api/auth/me": () => jsonResponse({ user: MANAGER_PROFILE }),
      "GET /api/users": () =>
        jsonResponse([
          { id: "emp-1", name: "Ivy Employee", email: "ivy@owo.com", role: "employee", team_id: "team-1" },
        ]),
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "grace@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("My team (1)")).toBeInTheDocument();
    expect(screen.getByText("Ivy Employee")).toBeInTheDocument();
    // Read-only: no role/team <select> for a manager to edit their teammate with.
    expect(screen.queryByLabelText(/Role for Ivy Employee/)).not.toBeInTheDocument();
  });

  it("shows an error message when login fails", async () => {
    signInWithEmailAndPassword.mockRejectedValueOnce(new Error("Invalid email or password."));
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
      "GET /api/auth/me": () => jsonResponse({ user: ADMIN_PROFILE }),
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
