# dsh-bili-feed

让 DSH 里的模型能看 B 站、刷 B 站、分享 B 站视频。

只有三件事，**全是只读 GET**：

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 看视频 | `bili_video` | 标题、UP、时长、播放/点赞/投币、简介、分区 |
| 刷首页 | `bili_feed` | 首页推荐流，热门榜兜底 |
| 分享 | `bili_share` | `【标题】 链接` 格式 |

**不做的事**：发评论、点赞、投币、收藏、关注、发弹幕。
需要鉴权的写接口一个都没接，所有请求都是无副作用的 GET。

## 安装

```bash
cd ~/.dsh/profiles/web
pnpm add /path/to/dsh-bili-feed
```

然后在 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: bili-feed
      name: dsh-bili-feed
      inject:
        - tools
      config:
        vdSource: afe7444fb0a17db50bfb3bdb60168af2
        cookie: ''
        feedCount: '12'
```

重启 `dsh web` 生效。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `vdSource` | `afe7444f...af2` | 分享链接末尾的 `vd_source` |
| `cookie` | 空 | 可选。不填也能用，填了推荐更接近你自己的首页 |
| `feedCount` | `12` | 每次刷首页默认几条，1-30 |

## 用法

```js
// 看视频 —— BV 号、av 号、完整链接、b23.tv 短链都认
bili_video({ id: "BV1y7nf6tEZa" })
bili_video({ id: "https://www.bilibili.com/video/BV1y7nf6tEZa/" })

// 刷首页
bili_feed({ count: 10 })
bili_feed({ count: 10, source: "popular" })   // 推荐流被风控时兜底

// 分享
bili_share({ id: "BV1y7nf6tEZa" })
bili_share({ id: "BV1y7nf6tEZa", withDesc: true })   // 带上 UP、时长、播放、简介
```

分享输出长这样：

```
【我让DeepSeek写《大学生何去何从》，第38版，它把我写进去了】 https://www.bilibili.com/video/BV1y7nf6tEZa/?share_source=copy_web&vd_source=afe7444fb0a17db50bfb3bdb60168af2
```

## 接口说明

实测过的情况：

| 接口 | 要不要签名 | 状态 |
| --- | --- | --- |
| `x/web-interface/view` | 不要 | 稳定 |
| `x/web-interface/popular` | 不要 | 稳定 |
| `x/web-interface/wbi/index/top/feed/rcmd` | 要 wbi | 能用 |
| `x/web-interface/ranking/v2` | 要 wbi | 被风控（-352），没用 |

### wbi 签名

1. `GET /x/web-interface/nav` 拿 `wbi_img.img_url` / `sub_url`（未登录会返回 -101，但 key 照样给）
2. 取两个 URL 的文件名去扩展名，拼成 `imgKey + subKey`（共 64 字符）
3. 按 B 站前端写死的 `MIXIN_TAB` 重排，取前 32 位 = `mixinKey`
4. 参数加 `wts`（秒级时间戳），按 key 排序、URL encode 拼 query
5. `w_rid = md5(query + mixinKey)`，拼到 query 后面

另外需要 `buvid3` cookie，从 `https://www.bilibili.com/` 的响应头拿。
key 缓存 1 小时。

## 为什么不用现成的

现成的 B 站插件大多带三件套：登录、评论、互动。
这里只想让模型**看**，不想让它**说**。所以从零写，接口白名单里只有 GET。
