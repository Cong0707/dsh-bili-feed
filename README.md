# dsh-bili-feed

让 DSH 里的模型能看 B 站、刷 B 站、读字幕、分享视频。

四件事，**全是只读 GET**：

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 看视频 | `bili_video` | 标题、UP、时长、播放/点赞/投币、简介、分区 |
| 刷首页 | `bili_feed` | 首页推荐流，热门榜兜底 |
| 读字幕 | `bili_subtitle` | B 站 AI 字幕全文，中/英/日等 |
| 分享 | `bili_share` | `【标题】 链接` 格式 |

**不做的事**：发评论、点赞、投币、收藏、关注、发弹幕。
需要写权限的接口一个都没接。

## 安装

```bash
cd ~/.dsh/profiles/web
pnpm add github:Cong0707/dsh-bili-feed
```

然后在 `cordis.patch.yml` 里加：

```yaml
- id: bili-feed
  name: dsh-bili-feed
  inject:
    - tools
  config:
    vdSource: <你的 vd_source>
    cookie: ''
    feedCount: '12'
```

重启 `dsh web` 生效。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `vdSource` | 空 | 分享链接末尾的 `vd_source`，填你自己的 |
| `cookie` | 空 | B 站登录 cookie。留空则读下面的文件 |
| `feedCount` | `12` | 每次刷首页默认几条，1-30 |

### cookie 放哪

别写进 `cordis.patch.yml`（明文配置，而且很长）。插件启动时会读：

```
~/.dsh/plugins-data/bili-feed/cookie.txt
```

文件内容就是一整行 `SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx`。

只有 `bili_subtitle` 需要它。看视频、刷首页、分享不用登录。

## 用法

```js
bili_video({ id: "BV1y7nf6tEZa" })
bili_feed({ count: 10 })
bili_feed({ count: 10, source: "popular" })

// 字幕
bili_subtitle({ id: "BV1y7nf6tEZa" })
bili_subtitle({ id: "BV1y7nf6tEZa", lang: "en" })
bili_subtitle({ id: "BV1y7nf6tEZa", withTime: true })   // 每行带 [0:12]

bili_share({ id: "BV1y7nf6tEZa" })
```

## 字幕的三个坑

这块比想的麻烦，记一下：

**1. 必须登录。** 未登录时 `player/v2` 的 `subtitles` 永远是空数组，
并且带 `need_login_subtitle: true`。

**2. `subtitle_url` 是一次性的。** 同一个 `aid+cid` 第二次请求，
6 种语言全部返回空 `url`。而且 `auth_key` 的过期时间基本就是**生成的那一刻**，
所以只能拿到 url 立刻下载，不能缓存 url。插件缓存的是**解析后的正文**（30 分钟）。

**3. 不是每个视频都有 AI 字幕。** 没有的时候 B 站会返回残缺内容，
甚至是**别的视频的字幕**。所以 `bili_subtitle` 会算一个覆盖率：

```
coverage = 字幕最后一秒 / 视频总时长
```

覆盖率低于 50% 会带 ⚠️ 警告。**看到警告别直接引用**，先拿内容和标题对一下。

实测：

| 视频 | 结果 |
| --- | --- |
| 为什么你的DeepSeek和别人不一样 | 442 条 / 5063 字 / 覆盖率 1.0 ✓ |
| 折1万次会坏吗 iPhone Duo 评测 | 214 条但内容是别的视频 ✗ |

## 接口

| 接口 | 要签名 | 状态 |
| --- | --- | --- |
| `x/web-interface/view` | 否 | 稳定 |
| `x/web-interface/popular` | 否 | 稳定 |
| `x/web-interface/wbi/index/top/feed/rcmd` | wbi | 能用 |
| `x/player/v2` | 否（但要登录） | 能用，见上面的坑 |
| `x/web-interface/ranking/v2` | wbi | -352 风控，没用 |

wbi 签名：拿 `nav` 的 `wbi_img.img_url` / `sub_url` 文件名拼成 64 字符，
按固定重排表取前 32 位当 `mixinKey`，参数加 `wts` 排序拼 query，
`w_rid = md5(query + mixinKey)`。key 缓存 1 小时。

## 为什么自己写

现成的 B 站插件大多带登录、评论、互动三件套。这里只想让模型**看**，不想让它**说**。
