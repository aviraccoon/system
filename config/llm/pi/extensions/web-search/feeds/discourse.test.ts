import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blurbText,
  type CategoryPath,
  categoryJsonUrl,
  categoryPath,
  classify,
  cookedToText,
  type DiscoursePost,
  type DiscourseTopic,
  discourseProvider,
  jsonUrlFor,
  loadDiscourseAuth,
  matches,
  mergePosts,
  paginationUrlFor,
  parseCategoryPath,
  renderCategoryList,
  renderCategoryTree,
  renderDiscourse,
  renderSearch,
  resolveCategoryId,
  resolveKeySpec,
  type SearchResponse,
  type SiteCategory,
  topicPath,
} from "./discourse";

describe("matches", () => {
  test("accepts topic URLs with slug and id", () => {
    expect(matches("https://discourse.nixos.org/t/some-topic/79490")).toBe(true);
  });

  test("accepts bare /t/<id>", () => {
    expect(matches("https://forum.example.com/t/123")).toBe(true);
  });

  test("accepts post-anchor suffix", () => {
    expect(matches("https://forum.example.com/t/slug/42/15")).toBe(true);
  });

  test("ignores query and fragment", () => {
    expect(matches("https://forum.example.com/t/slug/42?page=3#x")).toBe(true);
  });

  test("rejects non-topic paths", () => {
    expect(matches("https://forum.example.com/u/someone")).toBe(false);
    expect(matches("https://forum.example.com/latest-posts")).toBe(false);
    expect(matches("https://forum.example.com/searching")).toBe(false);
  });

  test("accepts category URLs", () => {
    expect(matches("https://forum.example.org/c/7/l/latest?board=default")).toBe(true);
    expect(matches("https://forum.example.org/c/project-x/21?ascending=false&order=posts")).toBe(true);
    expect(matches("https://forum.example.org/c/parent/child/33/l/top")).toBe(true);
  });

  test("accepts slug-only category paths (no id)", () => {
    expect(matches("https://forum.example.com/c/general/l/latest")).toBe(true);
    expect(matches("https://forum.example.com/c/parent/child")).toBe(true);
  });

  test("accepts search, site listings, and the category index", () => {
    expect(matches("https://forum.example.com/search?q=term")).toBe(true);
    expect(matches("https://forum.example.com/categories")).toBe(true);
    expect(matches("https://forum.example.com/latest")).toBe(true);
    expect(matches("https://forum.example.com/new")).toBe(true);
    expect(matches("https://forum.example.com/unread")).toBe(true);
    expect(matches("https://forum.example.com/top/weekly")).toBe(true);
  });

  test("rejects non-http", () => {
    expect(matches("ftp://forum.example.com/t/slug/42")).toBe(false);
  });
});

describe("classify / categoryPath / json URLs", () => {
  function partsOf(u: string): CategoryPath {
    const p = parseCategoryPath(u);
    if (!p) throw new Error(`not a category path: ${u}`);
    return p;
  }

  test("classifies topic vs category vs the other shapes", () => {
    expect(classify("https://f.io/t/s/1")).toBe("topic");
    expect(classify("https://f.io/t/s/1/5")).toBe("topic");
    expect(classify("https://f.io/c/7/l/latest")).toBe("category");
    expect(classify("https://f.io/c/x/21?order=posts")).toBe("category");
    expect(classify("https://f.io/c/general")).toBe("category");
    expect(classify("https://f.io/search?q=x")).toBe("search");
    expect(classify("https://f.io/categories")).toBe("categories");
    expect(classify("https://f.io/latest")).toBe("sitelist");
    expect(classify("https://f.io/top/weekly")).toBe("sitelist");
  });

  test("categoryPath keeps filter, strips query", () => {
    expect(categoryPath("https://forum.example.org/c/7/l/latest?board=default")).toBe("/c/7/l/latest");
    expect(categoryPath("https://forum.example.org/c/project-x/21?ascending=false")).toBe("/c/project-x/21");
  });

  test("category json URL: canonical path, order/ascending kept, rest dropped", () => {
    const u = "https://forum.example.org/c/project-x/21?ascending=false&order=posts&board=default";
    const parsed = new URL(categoryJsonUrl("https://forum.example.org", partsOf(u), 21, u));
    expect(parsed.pathname).toBe("/c/project-x/21.json");
    expect(parsed.searchParams.get("extras")).toBe("excerpts");
    expect(parsed.searchParams.get("order")).toBe("posts");
    expect(parsed.searchParams.get("ascending")).toBe("false");
    expect(parsed.searchParams.get("board")).toBe(null);
  });

  test("slug-only parts build the canonical id path with filter", () => {
    const u = "https://forum.example.org/c/parent/child/l/latest";
    const parsed = new URL(categoryJsonUrl("https://forum.example.org", partsOf(u), 33, u));
    expect(parsed.pathname).toBe("/c/parent/child/33/l/latest.json");
    expect(parsed.searchParams.get("extras")).toBe("excerpts");
  });

  test("paginationUrlFor json-ifies a more_topics_url with its query", () => {
    const url = new URL(paginationUrlFor("https://f.io", "/c/x/8/l/latest?page=1"));
    expect(url.pathname).toBe("/c/x/8/l/latest.json");
    expect(url.searchParams.get("extras")).toBe("excerpts");
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("topicPath / json URL", () => {
  test("strips query, fragment, and post anchor", () => {
    expect(topicPath("https://forum.example.com/t/slug/42/15?page=3#x")).toBe("/t/slug/42");
  });

  test("keeps bare id form", () => {
    expect(topicPath("https://forum.example.com/t/42")).toBe("/t/42");
  });

  test("json URL appends .json on the canonical path", () => {
    expect(jsonUrlFor("https://forum.example.com/t/slug/42/15?page=3")).toBe(
      "https://forum.example.com/t/slug/42.json",
    );
  });
});

describe("resolveKeySpec", () => {
  test("runs a !command and returns trimmed stdout", () => {
    expect(resolveKeySpec("!echo key123")).toBe("key123");
  });

  test("refuses raw (non-command) values", () => {
    expect(resolveKeySpec("raw-secret-value")).toBeNull();
  });

  test("null on failing command", () => {
    expect(resolveKeySpec("!exit 3")).toBeNull();
  });

  test("null on empty stdout", () => {
    expect(resolveKeySpec("!printf ''")).toBeNull();
  });
});

describe("loadDiscourseAuth", () => {
  const dir = mkdtempSync(join(tmpdir(), "discourse-auth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("parses entries, null on missing file", () => {
    const f = join(dir, "keys.json");
    writeFileSync(f, JSON.stringify({ "a.example": { apiKey: "!echo k", apiUsername: "u" } }));
    expect(loadDiscourseAuth(f)?.["a.example"]?.apiKey).toBe("!echo k");
    expect(loadDiscourseAuth(join(dir, "missing.json"))).toBeNull();
  });

  test("null on malformed JSON", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{nope");
    expect(loadDiscourseAuth(f)).toBeNull();
  });
});

describe("cookedToText", () => {
  test("keeps code blocks as fences", () => {
    expect(cookedToText('<p>before</p><pre><code class="lang-nix">x = 1;</code></pre>')).toBe(
      "before\n\n```\nx = 1;\n```",
    );
  });

  test("newlines for block ends, dashes for list items", () => {
    expect(cookedToText("<p>a</p><ul><li>b</li><li>c</li></ul>")).toBe("a\n- b\n- c");
  });

  test("decodes entities and drops inline tags", () => {
    expect(cookedToText("<p>a &amp; b &lt;= <b>c</b></p>")).toBe("a & b <= c");
    expect(cookedToText("<p>end&hellip; mid&mdash;way</p>")).toBe("end… mid—way");
  });

  test("onebox link cards collapse to a single link line", () => {
    const onebox =
      '<aside class="onebox"><header class="source"><a href="https://fz.com">fz.com</a></header>' +
      '<article class="onebox-body"><h3><a href="https://fz.com/post">Some Post</a></h3>' +
      "<div><div><p>preview noise</p></div></div></article></aside>";
    expect(cookedToText(onebox)).toBe("[Some Post](https://fz.com/post)");
  });

  test("trailing whitespace and blank-line runs are collapsed", () => {
    expect(cookedToText("<p>a</p>\u00a0\u00a0<br>  \n\n\n<p>b</p>")).toBe("a\n\nb");
  });

  test("content images become markdown placeholders with dimensions", () => {
    const cooked =
      '<p>demo</p><div class="lightbox-wrapper"><a class="lightbox" href="https://fz.com/full.png">' +
      '<img src="https://fz.com/thumb.png" alt="image" width="690" height="412"></a>' +
      '<div class="meta"><span class="filename">image</span><span class="informations">690×412</span></div></div>';
    expect(cookedToText(cooked)).toBe("demo\n\n![image|690x412](https://fz.com/thumb.png)");
  });

  test("animated gif placeholder keeps its alt", () => {
    expect(cookedToText('<p><img src="https://fz.com/demo.gif" alt="chrome_demo" width="674" height="499"></p>')).toBe(
      "![chrome_demo|674x499](https://fz.com/demo.gif)",
    );
  });

  test("emoji images collapse to their alt glyph, avatars to nothing", () => {
    expect(
      cookedToText(
        '<p>hi <img class="emoji" alt="😎" src="https://fz.com/e.png"> <img class="onebox-avatar-inline" src="https://fz.com/a.png" width="20" height="20"></p>',
      ),
    ).toBe("hi 😎");
  });

  test("inline links keep their href as markdown", () => {
    expect(cookedToText('<p>see <a href="https://fz.com/t/x/1">the thread</a> for detail</p>')).toBe(
      "see [the thread](https://fz.com/t/x/1) for detail",
    );
  });

  test("heading anchor links collapse to their text", () => {
    expect(cookedToText('<h2><a name="h2-demo-1" href="#h2-demo-1"></a>Demo heading</h2>')).toBe("Demo heading");
  });

  test("link label strips nested tags", () => {
    expect(cookedToText('<a href="https://fz.com/x"><strong>bold</strong> label</a>')).toBe(
      "[bold label](https://fz.com/x)",
    );
  });
});

describe("mergePosts", () => {
  test("dedupes by post_number keeping first", () => {
    const posts = [
      { post_number: 1, username: "a", cooked: "x" },
      { post_number: 2, username: "b", cooked: "y" },
      { post_number: 1, username: "a", cooked: "x-dupe" },
    ] as DiscoursePost[];
    expect(mergePosts(posts).map((p) => p.post_number)).toEqual([1, 2]);
  });
});

describe("renderDiscourse", () => {
  const topic: DiscourseTopic = {
    title: "Multiverse thread",
    posts_count: 4,
    tags: ["rust", { name: "nix", slug: "nix" }],
    post_stream: {
      stream: [1, 2, 3, 4],
      posts: [
        { post_number: 1, username: "alice", cooked: "<p>root one</p>", score: 10 },
        {
          post_number: 2,
          username: "bob",
          cooked: "<p>reply to one</p>",
          score: 3,
          reply_to_post_number: 1,
        },
        {
          post_number: 3,
          username: "carol",
          cooked: "<p>reply to the reply</p>",
          reply_to_post_number: 2,
        },
        { post_number: 4, username: "dave", cooked: "<p>second root</p>", score: 0 },
      ],
    },
  };

  test("renders posts chronologically with reply markers instead of nesting", () => {
    const md = renderDiscourse(topic, "forum.example.com", 4);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Multiverse thread");
    expect(md).toContain("Tags: #rust #nix");
    const iAlice = lines.findIndex((l) => l.includes("alice"));
    const iBob = lines.findIndex((l) => l.includes("bob"));
    const iCarol = lines.findIndex((l) => l.includes("carol"));
    const iDave = lines.findIndex((l) => l.includes("dave"));
    expect(iAlice).toBeGreaterThan(-1);
    expect(iBob).toBe(iAlice + 1); // post order preserved, no reordering into trees
    expect(iCarol).toBe(iBob + 1);
    expect(iDave).toBe(iCarol + 1);
    expect(lines[iBob]).toMatch(/^- /); // no physical indentation
    expect(lines[iCarol]).toMatch(/^- /);
  });

  test("shows reply marker and score", () => {
    const md = renderDiscourse(topic, "forum.example.com", 4);
    expect(md).toContain("(#2, 3 pts, ↩ #1)");
  });

  test("notes unfetched posts when rendered < total", () => {
    const md = renderDiscourse(topic, "forum.example.com", 2);
    expect(md).toContain("2 more posts not fetched");
  });

  test("shows post date, edit date, and accepted-answer marker", () => {
    const md = renderDiscourse(
      {
        title: "Solved thread",
        posts_count: 2,
        post_stream: {
          stream: [1, 2],
          posts: [
            {
              post_number: 1,
              username: "erin",
              cooked: "<p>problem</p>",
              score: 2,
              created_at: "2026-08-01T10:00:00.000Z",
            },
            {
              post_number: 2,
              username: "finn",
              cooked: "<p>solution</p>",
              score: 6,
              created_at: "2026-08-02T09:00:00.000Z",
              updated_at: "2026-08-04T11:00:00.000Z",
              accepted_answer: true,
            },
          ],
        },
      },
      "forum.example.com",
      2,
    );
    expect(md).toContain("(#1, 2026-08-01, 2 pts)");
    expect(md).toContain("(#2, 2026-08-02, edited 2026-08-04, 6 pts, ✓ accepted)");
  });
});

describe("renderCategoryList", () => {
  const topics = [
    {
      id: 1,
      title: "Direct topic",
      slug: "direct-topic",
      posts_count: 3,
      category_id: 21,
      last_posted_at: "2026-08-20T10:00:00Z",
    },
    {
      id: 2,
      title: "Subcategory topic",
      slug: "sub-topic",
      posts_count: 12,
      category_id: 7,
      tags: [{ name: "urgent", slug: "urgent" }, "draft"],
      excerpt: "<p>about the <b>quarterly rollout</b></p>",
      pinned: true,
    },
    { id: 1, title: "dupe", slug: "d", posts_count: 9 },
  ];

  test("tags subcategory topics, dedupes, marks pinned, excerpts as one line", () => {
    const md = renderCategoryList(topics, "f.io", "General", false, {
      listingId: 21,
      nameOf: (id) => (id === 7 ? "beta-board" : undefined),
    });
    const lines = md.split("\n");
    expect(lines[0]).toBe("# General (category)");
    expect(md).toContain("**Direct topic** (3 posts, last 2026-08-20) — /t/direct-topic/1");
    expect(md).toContain("**Subcategory topic** (12 posts, in beta-board, #urgent #draft, pinned) — /t/sub-topic/2");
    expect(md).toContain("about the quarterly rollout");
    expect(md).not.toContain("dupe");
  });

  test("falls back to category id when the name map misses", () => {
    const md = renderCategoryList(topics, "f.io", "General", false, { listingId: 21 });
    expect(md).toContain("in category 7");
  });

  test("notes truncation", () => {
    const md = renderCategoryList(topics.slice(0, 1), "f.io", "X", true);
    expect(md).toContain("list truncated");
  });
});

describe("discourseProvider.fetch (categories)", () => {
  // Key mocks by pathname + sorted params so param ORDER never decides a match.
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  const page1 = {
    topic_list: {
      topics: [
        { id: 1, title: "T1", slug: "t1", posts_count: 2, category_id: 7 },
        { id: 2, title: "T2", slug: "t2", posts_count: 5 },
      ],
      more_topics_url: "/c/x/21/l/latest?page=1",
    },
  };
  const page2 = {
    topic_list: { topics: [{ id: 3, title: "T3", slug: "t3", posts_count: 1 }] },
  };
  const siteJson = {
    categories: [
      { id: 21, name: "General" },
      { id: 7, name: "beta-board" },
    ],
  };

  test("paginates via more_topics_url, resolves names via site.json", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 200, text: JSON.stringify(page1) },
      [key("https://f.io/c/x/21/l/latest.json?extras=excerpts&page=1")]: {
        status: 200,
        text: JSON.stringify(page2),
      },
      [key("https://f.io/site.json")]: { status: 200, text: JSON.stringify(siteJson) },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("General");
    expect(res.content).toContain("T3");
    expect(res.content).toContain("in beta-board");
    expect(res.content).not.toContain("list truncated");
  });

  test("403 without key returns the gated note for categories too", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 403, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("Login-gated Discourse");
  });

  test("site.json failure degrades to Category <id> without tags", async () => {
    const ctx = ctxWith({
      [key("https://f.io/c/x/21.json?extras=excerpts")]: { status: 200, text: JSON.stringify(page2) },
      [key("https://f.io/site.json")]: { status: 500, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.io/c/x/21", ctx);
    expect(res.title).toBe("Category 21");
  });
});

describe("parseCategoryPath", () => {
  test("splits slugs, id, filter", () => {
    expect(parseCategoryPath("https://f.io/c/parent/child/33/l/top")).toEqual({
      slugs: ["parent", "child"],
      id: 33,
      filter: "top",
    });
    expect(parseCategoryPath("https://f.io/c/general")).toEqual({
      slugs: ["general"],
      id: undefined,
      filter: undefined,
    });
    expect(parseCategoryPath("https://f.io/c/7/l/latest?board=default")).toEqual({
      slugs: [],
      id: 7,
      filter: "latest",
    });
    expect(parseCategoryPath("https://f.io/t/s/1")).toBeNull();
  });
});

describe("resolveCategoryId", () => {
  const cats: SiteCategory[] = [
    { id: 1, name: "root", slug: "root" },
    { id: 2, name: "child", slug: "child", parent_category_id: 1 },
    { id: 3, name: "other", slug: "child", parent_category_id: 9 },
  ];

  test("single slug prefers the root category", () => {
    expect(resolveCategoryId(cats, ["root"])).toBe(1);
  });

  test("walks nested slugs along the parent chain", () => {
    expect(resolveCategoryId(cats, ["root", "child"])).toBe(2);
  });

  test("falls back to the bare last slug when the chain is broken", () => {
    expect(resolveCategoryId(cats, ["missing", "child"])).toBe(2);
  });

  test("unknown slugs resolve to null", () => {
    expect(resolveCategoryId(cats, ["nope"])).toBeNull();
    expect(resolveCategoryId(cats, [])).toBeNull();
  });
});

describe("blurbText", () => {
  test("strips tags/entities, collapses whitespace, slices to 200", () => {
    expect(blurbText("<b>bold</b> &amp; <i>text</i>\nmore   spaces")).toBe("bold & text more spaces");
    expect(blurbText(undefined)).toBe("");
    expect(blurbText("x".repeat(250)).length).toBe(200);
  });
});

describe("renderSearch", () => {
  const res: SearchResponse = {
    topics: [
      { id: 5, title: "T5", slug: "t5", posts_count: 3, category_id: 7, tags: ["x"] },
      { id: 6, title: "T6", slug: "t6" },
    ],
    posts: [
      {
        topic_id: 5,
        post_number: 1,
        username: "u1",
        blurb: "<b>bold</b> &amp; text",
        created_at: "2026-09-01T10:00:00Z",
      },
      { topic_id: 5, post_number: 2, username: "u2" },
      { topic_id: 6, post_number: 1, username: "u3", blurb: "other" },
    ],
    categories: [{ id: 7, name: "General" }],
  };

  test("groups posts under topics with /t/ paths, category, and tags", () => {
    const md = renderSearch(res, "f.example", "hello world");
    expect(md.split("\n")[0]).toBe("# Search: hello world");
    expect(md).toContain("**T5** (3 posts, in General, #x) — /t/t5/5");
    expect(md).toContain("  - **u1** (#1, 2026-09-01): bold & text");
    expect(md).toContain("  - **u2** (#2): (no excerpt)");
    expect(md).toContain("**T6** — /t/t6/6");
  });

  test("empty results say so", () => {
    expect(renderSearch({ topics: [], posts: [] }, "f.example", "q")).toContain("No results.");
  });

  test("caps posts and points at the next page", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ topic_id: 5, post_number: i + 1, username: "u" }));
    const md = renderSearch({ topics: [{ id: 5, title: "T", slug: "t" }], posts: many }, "f.example", "q");
    expect(md).toContain("[... 1 more posts — add &page=2 to the search URL for the next page]");
  });
});

describe("renderCategoryTree", () => {
  const cats: SiteCategory[] = [
    { id: 1, name: "Root A", slug: "root-a", topic_count: 10, position: 0 },
    { id: 2, name: "Child A", slug: "child-a", parent_category_id: 1, topic_count: 4, position: 0 },
    {
      id: 3,
      name: "Root B",
      slug: "root-b",
      topic_count: 2,
      position: 1,
      description_text: "Board about things\nsecond line",
    },
  ];

  test("nests children, orders by position, shows paths, counts, descriptions", () => {
    const md = renderCategoryTree(cats, "f.example");
    const lines = md.split("\n");
    const iA = lines.findIndex((l) => l.includes("Root A"));
    const iChild = lines.findIndex((l) => l.includes("Child A"));
    const iB = lines.findIndex((l) => l.includes("Root B"));
    expect(iA).toBeGreaterThan(-1);
    expect(iChild).toBe(iA + 1);
    expect(iB).toBeGreaterThan(iChild);
    expect(lines[iA]).toContain("- **Root A** (/c/root-a/1, 10 topics)");
    expect(lines[iChild]).toMatch(/^ {2}- \*\*Child A\*\* \(\/c\/root-a\/child-a\/2, 4 topics\)/);
    expect(lines[iB]).toContain("/c/root-b/3, 2 topics");
    expect(lines[iB]).toContain("Board about things");
    expect(md).toContain("fetch a board: https://f.example/c/<slug-path>/<id>");
  });
});

describe("discourseProvider.fetch (slug-only categories)", () => {
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  const siteJson = {
    categories: [
      { id: 21, name: "General", slug: "general" },
      { id: 7, name: "beta-board", slug: "beta-board", parent_category_id: 21 },
    ],
  };

  test("resolves slug-only URLs via site.json", async () => {
    const ctx = ctxWith({
      [key("https://f.io/site.json")]: { status: 200, text: JSON.stringify(siteJson) },
      [key("https://f.io/c/general/beta-board/7.json?extras=excerpts")]: {
        status: 200,
        text: JSON.stringify({
          topic_list: { topics: [{ id: 9, title: "T9", slug: "t9", posts_count: 1, category_id: 21 }] },
        }),
      },
    });
    const res = await discourseProvider.fetch("https://f.io/c/general/beta-board", ctx);
    expect(res.title).toBe("beta-board");
    expect(res.content).toContain("in General");
  });

  test("unknown slugs throw (tryFeed falls back to HTML)", async () => {
    const ctx = ctxWith({
      [key("https://f.io/site.json")]: { status: 200, text: JSON.stringify({ categories: [] }) },
    });
    expect(discourseProvider.fetch("https://f.io/c/ghost", ctx)).rejects.toThrow("not found");
  });
});

describe("discourseProvider.fetch (search)", () => {
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  test("fetches search.json and renders grouped results", async () => {
    const ctx = ctxWith({
      [key("https://f.io/search.json?q=hello world")]: {
        status: 200,
        text: JSON.stringify({
          topics: [{ id: 5, title: "T5", slug: "t5", posts_count: 2, category_id: 7 }],
          posts: [
            { topic_id: 5, post_number: 1, username: "u1", blurb: "hit one" },
            { topic_id: 5, post_number: 2, username: "u2", blurb: "hit two" },
          ],
          categories: [{ id: 7, name: "General" }],
        }),
      },
    });
    const res = await discourseProvider.fetch("https://f.io/search?q=hello+world", ctx);
    expect(res.title).toBe("Search: hello world");
    expect(res.content).toContain("**T5** (2 posts, in General) — /t/t5/5");
    expect(res.content).toContain("**u2** (#2): hit two");
  });

  test("missing q throws", async () => {
    const ctx = ctxWith({});
    expect(discourseProvider.fetch("https://f.io/search", ctx)).rejects.toThrow("?q=");
  });
});

describe("discourseProvider.fetch (site listings)", () => {
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  test("renders /latest with per-topic board names", async () => {
    const ctx = ctxWith({
      [key("https://f.io/latest.json?extras=excerpts")]: {
        status: 200,
        text: JSON.stringify({
          topic_list: { topics: [{ id: 1, title: "T1", slug: "t1", posts_count: 2, category_id: 7 }] },
        }),
      },
      [key("https://f.io/site.json")]: {
        status: 200,
        text: JSON.stringify({ categories: [{ id: 7, name: "beta-board" }] }),
      },
    });
    const res = await discourseProvider.fetch("https://f.io/latest", ctx);
    expect(res.title).toBe("Latest topics");
    expect(res.content).toContain("# Latest topics (listing)");
    expect(res.content).toContain("in beta-board");
    expect(res.content).toContain("All boards: /categories");
  });

  test("top period subpaths name the period", async () => {
    const ctx = ctxWith({
      [key("https://f.io/top/weekly.json?extras=excerpts")]: {
        status: 200,
        text: JSON.stringify({ topic_list: { topics: [] } }),
      },
    });
    const res = await discourseProvider.fetch("https://f.io/top/weekly", ctx);
    expect(res.title).toBe("Top topics (weekly)");
  });
});

describe("discourseProvider.fetch (categories index)", () => {
  function key(url: string): string {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return `${u.pathname}?${params}`;
  }
  function ctxWith(pages: Record<string, { status: number; text: string }>) {
    const http = async (url: string) => pages[key(url)] ?? { status: 404, text: "" };
    return { httpFetch: http } as never as Parameters<typeof discourseProvider.fetch>[1];
  }

  test("renders the site.json tree", async () => {
    const ctx = ctxWith({
      [key("https://f.io/site.json")]: {
        status: 200,
        text: JSON.stringify({
          categories: [
            { id: 21, name: "General", slug: "general", topic_count: 10, position: 0 },
            { id: 7, name: "beta-board", slug: "beta-board", parent_category_id: 21, topic_count: 4, position: 0 },
          ],
        }),
      },
    });
    const res = await discourseProvider.fetch("https://f.io/categories", ctx);
    expect(res.title).toBe("Categories");
    expect(res.content).toContain("- **General** (/c/general/21, 10 topics)");
    expect(res.content).toContain("  - **beta-board** (/c/general/beta-board/7, 4 topics)");
  });
});

describe("discourseProvider.fetch (topics)", () => {
  function ctxWith(pages: Record<string, { status: number; text: string }>): {
    ctx: Parameters<typeof discourseProvider.fetch>[1];
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        httpFetch: async (url: string) => {
          calls.push(url);
          return pages[url] ?? { status: 404, text: "" };
        },
      },
    };
  }

  const page1: DiscourseTopic = {
    title: "T",
    posts_count: 3,
    post_stream: {
      stream: [1, 2, 3],
      posts: [
        { post_number: 1, username: "a", cooked: "<p>one</p>" },
        { post_number: 2, username: "b", cooked: "<p>two</p>" },
      ],
    },
  };
  const page2: DiscourseTopic = {
    ...page1,
    post_stream: {
      stream: [1, 2, 3],
      posts: [{ post_number: 3, username: "c", cooked: "<p>three</p>" }],
    },
  };

  test("paginates until stream is covered", async () => {
    const { ctx, calls } = ctxWith({
      "https://f.example/t/s/1.json": { status: 200, text: JSON.stringify(page1) },
      "https://f.example/t/s/1.json?page=2": { status: 200, text: JSON.stringify(page2) },
    });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.title).toBe("T");
    expect(res.content).toContain("three");
    expect(calls).toHaveLength(2);
  });

  test("returns actionable note on 403 without key", async () => {
    const { ctx } = ctxWith({ "https://f.example/t/s/1.json": { status: 403, text: "" } });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.title).toBe("Login-gated Discourse");
    expect(res.content).toContain("discourse-keys.json");
    expect(res.content).toContain("op --account");
  });

  test("throws on non-200 (lets tryFeed fall back to HTML)", async () => {
    const { ctx } = ctxWith({ "https://f.example/t/s/1.json": { status: 500, text: "" } });
    expect(discourseProvider.fetch("https://f.example/t/s/1", ctx)).rejects.toThrow("HTTP 500");
  });

  test("keeps partial posts when a later page fails", async () => {
    const { ctx } = ctxWith({
      "https://f.example/t/s/1.json": { status: 200, text: JSON.stringify(page1) },
      "https://f.example/t/s/1.json?page=2": { status: 500, text: "" },
    });
    const res = await discourseProvider.fetch("https://f.example/t/s/1", ctx);
    expect(res.content).toContain("two");
    expect(res.content).toContain("1 more posts not fetched");
  });
});
