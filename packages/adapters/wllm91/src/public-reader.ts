import { load } from "cheerio";
import { jobInput, type JobInput } from "../../../contracts/src/index.js";
import { AppError, requireCondition } from "../../../domain/src/errors.js";

export const HBEU_TEMPLATE = Object.freeze({
  school: "湖北工程学院",
  school_id: "hbeu",
  base_url: "https://hbeu.91wllm.cn",
  sample_url: "https://hbeu.91wllm.cn/teachin/view/id/252013",
  job_seeker_type: "GRADUATE" as const,
});
export type PublicNotice = {
  source_url: string;
  external_id: string;
  title: string;
  school: string;
  event_date: string | null;
  event_time: string | null;
  venue: string | null;
  company_url: string | null;
};
export type PublicPage = {
  kind: "TEACHIN" | "COMPANY_JOBS" | "JOB";
  source_url: string;
  observed_at: string;
  jobs: JobInput[];
  notice: PublicNotice | null;
  links: { title: string; url: string }[];
  warnings: string[];
  capability: "LIMITED";
};
export function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      "INVALID_PUBLIC_URL",
      "请输入湖北工程学院的公开页面链接",
    );
  }
  requireCondition(
    url.protocol === "https:" &&
      url.hostname === "hbeu.91wllm.cn" &&
      !url.port &&
      !url.username &&
      !url.password,
    "INVALID_PUBLIC_URL",
    "当前模板只支持 https://hbeu.91wllm.cn 的公开页面",
  );
  requireCondition(
    /^\/(?:teachin|job)\/view\/id\/\d+\/?$/.test(url.pathname) ||
      /^\/company\/view\/id\/\d+(?:\/tab\/1)?\/?$/.test(url.pathname),
    "INVALID_PUBLIC_ROUTE",
    "仅支持宣讲会、岗位和企业岗位公开页面",
  );
  // Only canonical page identifiers are sent. No tokens or user query strings.
  url.search = "";
  url.hash = "";
  if (/^\/company\/view\/id\/\d+\/?$/.test(url.pathname))
    url.pathname = url.pathname.replace(/\/$/, "") + "/tab/1";
  return url;
}
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
export function parsePublicPage(
  html: string,
  rawUrl: string,
  observedAt = new Date().toISOString(),
): PublicPage {
  const url = publicUrl(rawUrl),
    $ = load(html);
  $("script,style,noscript,iframe").remove();
  const body = clean($("body").text()),
    title = clean(
      $(".title-message h5").first().text() || $("h5").first().text(),
    );
  requireCondition(
    title.length > 0 &&
      !/验证码|访问过于频繁|安全验证|登录|请先/.test(title) &&
      !/访问过于频繁|请完成安全验证/.test(body),
    "PUBLIC_PAGE_UNAVAILABLE",
    "页面需要登录或验证，已停止读取",
  );
  const warnings = [
    "仅读取当前公开页面；账号、消息及投递能力未验证。",
    "缺失字段保留未知，请到原网页核实申请条件。",
  ];
  const links: { title: string; url: string }[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("javascript:")) return;
    try {
      const target = publicUrl(new URL(href, url).href);
      if (target.href !== url.href && !links.some((l) => l.url === target.href))
        links.push({
          title: clean($(el).text()).slice(0, 200) || "来源页面",
          url: target.href,
        });
    } catch {}
  });
  const companyLink = links.find((l) =>
    new URL(l.url).pathname.startsWith("/company/"),
  );
  const field = (label: string, end: string) =>
    body
      .match(new RegExp(`${label}[：:]\\s*(.*?)\\s*(?:${end})`))?.[1]
      ?.trim() || null;
  const nature = field("单位性质", "单位行业");
  const jobs: JobInput[] = [];
  const make = (
    jobUrl: string,
    jobTitle: string,
    company: string,
    parts: (string | null)[],
    majors: string | null,
    publishedDate: string | null = null,
  ) => {
    const salary = parts[0] || null;
    const range = salary?.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
    return jobInput.parse({
      external_job_id: new URL(jobUrl).pathname.match(/\/id\/(\d+)/)![1],
      source_instance_id: "public:wllm91:hbeu",
      source_url: jobUrl,
      platform: "wllm91",
      mode: "REAL",
      title: jobTitle,
      company_name: company,
      salary_raw: salary,
      salary_min: range ? Number(range[1]) : null,
      salary_max: range ? Number(range[2]) : null,
      locations: parts[1] ? [parts[1]] : null,
      employment_type: parts[2] || null,
      education: parts[3] || null,
      majors: majors ? majors.split("、").map(clean).filter(Boolean) : null,
      published_date: publishedDate,
      company_nature: nature ? [nature] : null,
      nature_evidence_url: nature ? url.href : null,
      nature_verified: false,
      status: "UNVERIFIED",
      apply_target: { kind: "UNKNOWN", url: jobUrl },
      extra: {
        access: "PUBLIC_READ_ONLY",
        school: HBEU_TEMPLATE.school,
        requires_manual_application: true,
        detail_loaded: url.pathname.startsWith("/job/"),
        description_coverage: "UNAVAILABLE_DYNAMIC_CONTENT",
        salary_units: "NOT_EXPLICIT",
        company_url: companyLink?.url ?? null,
      },
    });
  };
  let notice: PublicNotice | null = null;
  let kind: PublicPage["kind"];
  if (url.pathname.startsWith("/teachin/")) {
    kind = "TEACHIN";
    notice = {
      source_url: url.href,
      external_id: url.pathname.match(/\/id\/(\d+)/)![1]!,
      title,
      school: HBEU_TEMPLATE.school,
      event_date:
        body.match(/宣讲日期[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
      event_time:
        body.match(/宣讲时间[：:]\s*(\d{2}:\d{2}[-–]\d{2}:\d{2})/)?.[1] ?? null,
      venue: null,
      company_url: companyLink?.url ?? null,
    };
    warnings.push(
      "此链接是宣讲会公告，未将公告直接当作可投递岗位；场地及正文需查看原网页。",
    );
  } else if (url.pathname.startsWith("/company/")) {
    kind = "COMPANY_JOBS";
    $("tr").each((_, el) => {
      const row = $(el),
        a = row.find('a[href^="/job/view/id/"]').first();
      if (!a.length) return;
      const parts = row
        .find(".info-text ul li")
        .map((_, li) => clean($(li).text()))
        .get();
      const majors =
        clean(
          row.find(".middle-container [title]").first().attr("title") ?? "",
        ) || null;
      jobs.push(
        make(
          publicUrl(new URL(a.attr("href")!, url).href).href,
          clean(a.text()),
          title,
          parts,
          majors,
        ),
      );
    });
    requireCondition(
      jobs.length > 0,
      "PUBLIC_SCHEMA_CHANGED",
      "未识别到岗位行，保留已有数据，请在原网页核实",
    );
  } else {
    kind = "JOB";
    const salary = clean($(".message-info .salary").first().text()) || null;
    const detail = clean($(".message-info .education").text())
      .split("|")
      .map(clean)
      .filter(Boolean);
    requireCondition(
      detail.length >= 3 && companyLink,
      "PUBLIC_SCHEMA_CHANGED",
      "岗位页面结构发生变化，未保存不完整记录",
    );
    jobs.push(
      make(
        url.href,
        title,
        companyLink.title,
        [salary, detail[0] ?? null, detail[1] ?? null, detail[2] ?? null],
        field("需求专业", "职位详情"),
        body.match(/(\d{4}-\d{2}-\d{2})发布/)?.[1] ?? null,
      ),
    );
    warnings.push(
      "职位正文由网页动态加载，当前未读取；薪资未明示币种和周期，数值不能直接用于月薪筛选。",
    );
  }
  return {
    kind,
    source_url: url.href,
    observed_at: observedAt,
    jobs,
    notice,
    links: links.slice(0, 50),
    warnings,
    capability: "LIMITED",
  };
}
export class PublicWllmReader {
  private nextRead = 0;
  private active = false;
  constructor(
    private fetcher: typeof fetch = fetch,
    private cooldownMs = 5000,
  ) {}
  async read(rawUrl: string): Promise<PublicPage> {
    const url = publicUrl(rawUrl);
    requireCondition(
      !this.active && Date.now() >= this.nextRead,
      "PUBLIC_READ_COOLDOWN",
      "请间隔 5 秒后读取下一页",
      429,
    );
    this.nextRead = Date.now() + this.cooldownMs;
    this.active = true;
    try {
      const response = await this.fetcher(url, {
        redirect: "manual",
        credentials: "omit",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(15000),
      });
      requireCondition(
        response.status === 200,
        "PUBLIC_HTTP_ERROR",
        `公开页面返回 ${response.status}，未继续访问或修改已有数据`,
        502,
      );
      requireCondition(
        response.headers.get("content-type")?.includes("text/html"),
        "PUBLIC_CONTENT_TYPE",
        "来源未返回 HTML 页面",
        502,
      );
      requireCondition(
        Number(response.headers.get("content-length") ?? 0) <= 2 * 1024 * 1024,
        "PUBLIC_PAGE_TOO_LARGE",
        "来源页面超过读取上限",
        502,
      );
      const stream = response.body?.getReader();
      requireCondition(stream, "PUBLIC_EMPTY_BODY", "来源页面没有内容", 502);
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await stream.read();
          if (part.done) break;
          length += part.value.length;
          requireCondition(
            length <= 2 * 1024 * 1024,
            "PUBLIC_PAGE_TOO_LARGE",
            "来源页面超过读取上限",
            502,
          );
          chunks.push(part.value);
        }
      } finally {
        await stream.cancel();
      }
      return parsePublicPage(Buffer.concat(chunks).toString("utf8"), url.href);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "PUBLIC_READ_FAILED",
        "来源读取超时或暂不可访问，已有记录已保留",
        502,
      );
    } finally {
      this.active = false;
    }
  }
}
