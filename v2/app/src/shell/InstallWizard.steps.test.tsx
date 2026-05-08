/**
 * Smoke + integration tests for the magical-onboarding wizard
 * (PRD-103 Phase 0.5).
 *
 * Goal is to catch the "wizard is broken" regression on every run.
 * Per-step coverage is kept thin — verifying that the right copy
 * shows, the primary IPC fires with the right shape, and the next
 * step transitions on success. Edge cases (gitconfig parsing, slug
 * collision, etc.) live in the underlying unit tests
 * (profile.rs tests, updater.test.ts).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The wizard imports @tauri-apps/plugin-dialog dynamically. Mock it
// up-front so the picker tests can intercept.
const dialogOpenMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
}));

import {
  resetInvokeMock,
  setInvokeHandlers,
} from "../test/invokeMock";
import { InstallWizard } from "./InstallWizard";

const noop = () => {};

const baseStatus = {
  checks: [
    { id: "content-root", label: "Content root", ok: true, detail: "found", fix_hint: "" },
    { id: "claude-cli", label: "Claude CLI", ok: false, detail: "not found", fix_hint: "" },
    { id: "calendar-source", label: "Calendar", ok: false, detail: "not configured", fix_hint: "" },
  ],
  all_ok: false,
};

function setBaselineHandlers(overrides: Record<string, unknown> = {}): void {
  setInvokeHandlers({
    install_status: () => baseStatus,
    claude_config_get: () => ({
      binary_path: "",
      settings_path: "",
      extra_args: [],
    }),
    claude_status: () => ({
      binary_path_configured: "",
      binary_path_resolved: null,
      settings_path: "",
      extra_args: [],
      default_extra_args: [],
      available: false,
      config_file: "",
    }),
    calendar_config_get: () => ({ ics_url: "", transport: "eventkit" }),
    calendar_config_set: () => null,
    recovery_status: () => ({ wrapped_present: false, confirmed: false }),
    content_root_info: () => ({
      current: "/Users/test/Documents/Chief of Staff/data/files",
      default: "/Users/test/Documents/Chief of Staff/data/files",
      has_choice: false,
      env_override: false,
    }),
    profile_get: () => ({
      name: "",
      email: "",
      role: "",
      team: "",
      manager: null,
      direct_reports: [],
    }),
    profile_gitconfig_defaults: () => ({
      name: "Alice Smith",
      email: "alice@example.com",
    }),
    profile_set: () => null,
    profile_scaffold_people: () => ({
      created: [],
      skipped: [],
    }),
    claude_ping: () => "ok",
    calendar_events: () => [],
    ...overrides,
  });
}

beforeEach(() => {
  resetInvokeMock();
  dialogOpenMock.mockReset();
  window.localStorage.clear();
  setBaselineHandlers();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("InstallWizard — Welcome step (0.5.1)", () => {
  it("opens on Welcome with the magical-onboarding copy", async () => {
    render(<InstallWizard onDismiss={noop} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Your day, organized — without the busywork/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/let's go →/)).toBeInTheDocument();
    expect(
      screen.getByText(/skip — I'll explore on my own/),
    ).toBeInTheDocument();
  });

  it("clicking 'let's go' advances to the identity step", async () => {
    render(<InstallWizard onDismiss={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/let's go →/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/let's go →/));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "About you" }),
      ).toBeInTheDocument();
    });
  });

  it("clicking 'skip' calls onDismiss without going through any step", async () => {
    const onDismiss = vi.fn();
    render(<InstallWizard onDismiss={onDismiss} />);
    await waitFor(() =>
      expect(screen.getByText(/skip — I'll explore on my own/))
        .toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/skip — I'll explore on my own/));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("InstallWizard — Identity step (0.5.2)", () => {
  it("pre-fills name + email from gitconfig when profile is empty", async () => {
    render(<InstallWizard onDismiss={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/let's go →/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/let's go →/));
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(/Alice Smith/) as HTMLInputElement;
      expect(nameInput.value).toBe("Alice Smith");
    });
    const emailInput = screen.getByPlaceholderText(
      /alice@example.com/,
    ) as HTMLInputElement;
    expect(emailInput.value).toBe("alice@example.com");
  });

  it("does NOT overwrite an on-disk profile with gitconfig defaults", async () => {
    setInvokeHandlers({
      profile_get: () => ({
        name: "Existing User",
        email: "existing@example.com",
        role: "Director",
        team: "",
        manager: null,
        direct_reports: [],
      }),
    });
    render(<InstallWizard onDismiss={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/let's go →/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/let's go →/));
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(/Alice Smith/) as HTMLInputElement;
      expect(nameInput.value).toBe("Existing User");
    });
  });

  it("save advances to the data step and calls profile_set", async () => {
    const profileSet = vi.fn();
    setInvokeHandlers({ profile_set: profileSet });
    render(<InstallWizard onDismiss={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/let's go →/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/let's go →/));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Alice Smith/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText(/save \+ next/));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Data folder/ }),
      ).toBeInTheDocument();
    });
    expect(profileSet).toHaveBeenCalledOnce();
  });

  it("skip → fill in later advances to data without calling profile_set", async () => {
    const profileSet = vi.fn();
    setInvokeHandlers({ profile_set: profileSet });
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    await screen.findByPlaceholderText(/Alice Smith/);
    fireEvent.click(screen.getByText(/skip — fill in later/));
    await screen.findByRole("heading", { name: /Data folder/ });
    expect(profileSet).not.toHaveBeenCalled();
  });

  it("identity inputs cap at sensible maxLength values (paste-bomb defense)", async () => {
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    const nameInput = (await screen.findByPlaceholderText(
      /Alice Smith/,
    )) as HTMLInputElement;
    expect(nameInput.maxLength).toBe(120);
  });
});

describe("InstallWizard — Data folder step (0.1 / 0.2)", () => {
  it("shows the active path resolved by content_root_info", async () => {
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    fireEvent.click(await screen.findByText(/skip — fill in later/));
    await waitFor(() => {
      expect(
        screen.getByText("/Users/test/Documents/Chief of Staff/data/files"),
      ).toBeInTheDocument();
    });
  });

  it("'choose different folder' invokes the dialog plugin and persists on selection", async () => {
    dialogOpenMock.mockResolvedValueOnce("/Users/test/Documents/Other");
    const rootSet = vi.fn(
      () => "/Users/test/Documents/Other",
    );
    setInvokeHandlers({ content_root_set: rootSet });
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    fireEvent.click(await screen.findByText(/skip — fill in later/));
    fireEvent.click(await screen.findByText(/choose different folder/));
    await waitFor(() => expect(rootSet).toHaveBeenCalledOnce());
  });

  it("env override surfaces the explanatory note", async () => {
    setInvokeHandlers({
      content_root_info: () => ({
        current: "/tmp/cos-fresh/data/files",
        default: "/Users/test/Documents/Chief of Staff/data/files",
        has_choice: false,
        env_override: true,
      }),
    });
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    fireEvent.click(await screen.findByText(/skip — fill in later/));
    await waitFor(() => {
      expect(
        screen.getByText(/COS_CONTENT_ROOT/),
      ).toBeInTheDocument();
    });
  });
});

describe("InstallWizard — Claude step (0.5.3) probe", () => {
  async function advanceToClaude() {
    render(<InstallWizard onDismiss={noop} />);
    fireEvent.click(await screen.findByText(/let's go →/));
    fireEvent.click(await screen.findByText(/skip — fill in later/));
    // The data-step's primary action moves to "Claude". After the
    // 0.5 polish pass the label is just "next →" so use the
    // primary-action role + position rather than text.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /next →/ }))[0]!,
    );
    await screen.findByText("Connect Claude");
  }

  it("auto-fills the path from claude_status when configured path is empty", async () => {
    setInvokeHandlers({
      claude_status: () => ({
        binary_path_configured: "",
        binary_path_resolved: "/opt/homebrew/bin/claude",
        settings_path: "",
        extra_args: [],
        default_extra_args: [],
        available: false,
        config_file: "",
      }),
    });
    await advanceToClaude();
    const input = (await screen.findByPlaceholderText(
      /\.claude\/local\/claude/,
    )) as HTMLInputElement;
    expect(input.value).toBe("/opt/homebrew/bin/claude");
  });

  it("'test the connection' shows ✓ on success", async () => {
    setInvokeHandlers({
      claude_status: () => ({
        binary_path_configured: "",
        binary_path_resolved: "/opt/homebrew/bin/claude",
        settings_path: "",
        extra_args: [],
        default_extra_args: [],
        available: false,
        config_file: "",
      }),
      claude_ping: () => "ok · reached Claude CLI (5 bytes)",
    });
    await advanceToClaude();
    fireEvent.click(screen.getByText(/test the connection/));
    await waitFor(() => {
      expect(screen.getByText(/Claude responded/)).toBeInTheDocument();
    });
  });

  it("'test the connection' surfaces the error inline on failure", async () => {
    setInvokeHandlers({
      claude_status: () => ({
        binary_path_configured: "",
        binary_path_resolved: "/opt/homebrew/bin/claude",
        settings_path: "",
        extra_args: [],
        default_extra_args: [],
        available: false,
        config_file: "",
      }),
      claude_ping: () => {
        throw new Error("claude binary not found");
      },
    });
    await advanceToClaude();
    fireEvent.click(screen.getByText(/test the connection/));
    await waitFor(() => {
      expect(screen.getByText(/claude binary not found/)).toBeInTheDocument();
    });
  });
});

// First-person step coverage: full-flow integration test left out
// because the wizard's mount-time "skip past OK steps" logic makes
// it tricky to land precisely there in a test (the all-ok branch
// jumps to "done", and any unconfirmed-checks branch lands on the
// broken step instead). The step's UI shape is the same as the
// identity step (covered above), and its IPC/scaffold path is
// covered exhaustively by the Rust unit tests in profile.rs:
//   - scaffold_creates_readmes_for_each_person
//   - scaffold_skips_existing_readmes
//   - scaffold_skips_blank_or_unsluggable_names
//   - slugify_handles_common_cases
