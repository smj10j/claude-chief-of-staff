import { describe, expect, it } from "vitest";

import {
  extractConferenceLink,
  plainDescription,
} from "./conferenceLink";

describe("extractConferenceLink", () => {
  it("returns null for empty/missing input", () => {
    expect(extractConferenceLink(null)).toBeNull();
    expect(extractConferenceLink(undefined)).toBeNull();
    expect(extractConferenceLink("")).toBeNull();
    expect(extractConferenceLink("just some text")).toBeNull();
  });

  it("extracts a Zoom join URL with subdomain", () => {
    const desc =
      "Join Zoom Meeting\nhttps://example.zoom.us/j/86910473341\n\nMeeting ID: ...";
    const got = extractConferenceLink(desc);
    expect(got).toEqual({
      kind: "Zoom",
      url: "https://example.zoom.us/j/86910473341",
    });
  });

  it("decodes &amp; in URLs (Google Calendar HTML body)", () => {
    const desc =
      'Join: <a href="https://example.zoom.us/j/89808844437?pwd=abc&amp;jst=2">link</a>';
    const got = extractConferenceLink(desc);
    expect(got?.url).toContain("&jst=2");
    expect(got?.url).not.toContain("&amp;");
  });

  it("extracts a Google Meet URL", () => {
    const desc = "Meeting link: https://meet.google.com/abc-defg-hij";
    expect(extractConferenceLink(desc)).toEqual({
      kind: "Google Meet",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("extracts a Teams URL", () => {
    const desc =
      "Click here to join: https://teams.microsoft.com/l/meetup-join/19%3a abcdef";
    const got = extractConferenceLink(desc);
    expect(got?.kind).toBe("Microsoft Teams");
    expect(got?.url).toContain("teams.microsoft.com/l/meetup-join/");
  });

  it("prefers Zoom over Google Meet when both appear", () => {
    const desc =
      "Backup: https://meet.google.com/abc-defg-hij\nMain: https://example.zoom.us/j/123";
    expect(extractConferenceLink(desc)?.kind).toBe("Zoom");
  });
});

describe("plainDescription", () => {
  it("strips HTML tags", () => {
    expect(plainDescription("<p>hello <strong>world</strong></p>")).toBe(
      "hello world",
    );
  });

  it("converts <br> to newlines", () => {
    expect(plainDescription("line one<br>line two<br/>line three")).toBe(
      "line one\nline two\nline three",
    );
  });

  it("decodes common HTML entities", () => {
    expect(
      plainDescription("Tom &amp; Jerry &lt;3 &nbsp;forever"),
    ).toBe("Tom & Jerry <3  forever");
  });

  it("returns empty string for null/undefined", () => {
    expect(plainDescription(null)).toBe("");
    expect(plainDescription(undefined)).toBe("");
  });
});
