import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: null,
  authCallback: null,
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn((_auth, callback) => {
    mocks.authCallback = callback;
    queueMicrotask(() => callback(mocks.currentUser));
    return vi.fn();
  }),
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signOut: mocks.signOut,
}));

import App from "./App";

const API_URL = "http://localhost:4000";
const USER = { id: "u1", name: "Ada Lovelace", email: "ada@owo.com", role: "employee", organization_id: "org1", team_id: "team1" };
const EMPTY_SUMMARY = { totalsByCategory: {}, grandTotal: 0, count: 0, month: "2026-01", monthSpentByCategory: {}, budgets: {} };

function jsonResponse(body, { ok = true, status = ok ? 200 : 400 } = {}) {
  return { ok, status, json: async () => body };
}

function mockFetch(overrides = {}) {
  return vi.fn((url, options = {}) => {
    const method = options.method || "GET";
    const key = `${method} ${url.replace(API_URL, "")}`;
    if (overrides[key]) return Promise.resolve(overrides[key]());
    if (key === "GET /api/auth/me") return Promise.resolve(jsonResponse({ user: USER }));
    if (key.startsWith("GET /api/categories")) return Promise.resolve(jsonResponse(["Rent", "Utilities"]));
    if (key.startsWith("GET /api/expenses")) return Promise.resolve(jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }));
    if (key.startsWith("GET /api/summary")) return Promise.resolve(jsonResponse(EMPTY_SUMMARY));
    if (key.startsWith("GET /api/budgets")) return Promise.resolve(jsonResponse({}));
    throw new Error(`Unhandled fetch in test: ${key}`);
  });
}

function firebaseUser() {
  return { uid: "u1", getIdToken: vi.fn().mockResolvedValue("firebase-token") };
}

beforeEach(() => {
  mocks.currentUser = null;
  mocks.authCallback = null;
  mocks.signInWithEmailAndPassword.mockReset();
  mocks.signOut.mockReset();
  global.fetch = mockFetch();
});

afterEach(() => vi.restoreAllMocks());

describe("App Firebase auth flow", () => {
  it("shows the login screen when Firebase has no active user", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Owo Track" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeInTheDocument();
  });

  it("switches to the registration form", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Owo Track" });
    await user.click(screen.getByRole("button", { name: "Register" }));
    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("signs in with Firebase and loads the profile from the API", async () => {
    const fbUser = firebaseUser();
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.currentUser = fbUser;
      mocks.authCallback?.(fbUser);
      return { user: fbUser };
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText(/Welcome, Ada Lovelace/)).toBeInTheDocument();
    expect(mocks.signInWithEmailAndPassword).toHaveBeenCalled();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      `${API_URL}/api/auth/me`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer firebase-token" }) })
    ));
  });

  it("shows a Firebase login error", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(new Error("Invalid email or password."));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Owo Track" });
    await user.type(screen.getByLabelText("Email"), "ada@owo.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("logs out through Firebase and returns to the login screen", async () => {
    mocks.currentUser = firebaseUser();
    mocks.signOut.mockImplementation(async () => {
      mocks.currentUser = null;
      mocks.authCallback?.(null);
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/Welcome, Ada Lovelace/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(mocks.signOut).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Login" })).toBeInTheDocument();
  });
});
