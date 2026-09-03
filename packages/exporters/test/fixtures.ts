import type { Playlist, Track } from '@playlist-exporter/contracts';

export const tracks: Track[] = [
  {
    title: '歌一',
    artists: ['歌手甲', '歌手乙'],
    album: '专辑一',
    trackId: 'same-track',
    source: 'netease',
    availability: 'available',
    position: 0,
    warnings: [],
  },
  {
    title: '下架曲',
    artists: ['[unknown artist]'],
    album: '专辑二',
    trackId: 'removed-track',
    source: 'netease',
    availability: 'removed',
    position: 1,
    warnings: ['artist metadata unavailable'],
  },
  {
    title: '不可用曲',
    artists: ['歌手丙'],
    album: '专辑三',
    trackId: 'unavailable-track',
    source: 'netease',
    availability: 'unavailable',
    position: 2,
    warnings: ['track unavailable'],
  },
  {
    title: '未知状态曲',
    artists: ['歌手丁'],
    trackId: 'unknown-track',
    source: 'netease',
    availability: 'unknown',
    position: 3,
    warnings: [],
  },
  {
    title: '歌一',
    artists: ['歌手甲', '歌手乙'],
    album: '专辑一',
    trackId: 'same-track',
    source: 'netease',
    availability: 'available',
    position: 4,
    warnings: [],
  },
];

export const playlist: Playlist = {
  id: 'playlist-1',
  name: '我的/歌单:测试',
  creator: '测试用户',
  source: 'netease',
  total: tracks.length,
  tracks,
  complete: true,
  warnings: [],
};
