const records = [
 ['dusk','Midnight Haze','Luna Vale','After Hours',218,'#513469','Electronic','2026-09-01'],
 ['tide','Soft Current','Kai Marlow','Low Tide',192,'#186666','Ambient','2026-08-15'],
 ['heat','Heat Mirage','The Static Suns','Desert Signal',241,'#913a20','Indie Rock','2026-10-10'],
 ['bloom','Pink Noise','Mira Sol','Velvet Bloom',207,'#792857','Synthpop','2026-07-20'],
 ['orbit','Pale Blue','Atlas North','Lunar Drift',226,'#284071','Ambient','2026-06-30'],
 ['dusk','Blue Hour','Luna Vale','After Hours',183,'#513469','Electronic','2026-09-05'],
 ['tide','Saltwater Glass','Kai Marlow','Low Tide',201,'#186666','Ambient','2026-08-20'],
 ['heat','A Road of Light','The Static Suns','Desert Signal',234,'#913a20','Indie Rock','2026-10-15'],
 ['bloom','Petal Theory','Mira Sol','Velvet Bloom',196,'#792857','Synthpop','2026-07-25'],
 ['orbit','Out of Orbit','Atlas North','Lunar Drift',212,'#284071','Ambient','2026-07-02']
];
export const songs = records.map(([art,title,artist,album,duration,color,genre,releaseDate],i)=>({id:`s${i}`,art,title,artist,artistId:`artist${i%5}`,album,albumId:`album${i%5}`,duration,color,genre,releaseDate,type:'song'}));
const collect=(type,key)=>songs.slice(0,5).map((s,i)=>({...s,id:`${type}${i}`,title:s[key],type,artistId:`artist${i}`,tracks:songs.filter(t=>t[key]===s[key]).map(t=>t.id)}));
export const albums=collect('album','album');
export const artists=collect('artist','artist');
export const playlists=[
 ['Night Drive','Neon horizons and empty highways.','dusk',[0,4,5,9]],
 ['Deep Focus','Drift into a quieter headspace.','tide',[1,6,4]],
 ['Golden Hour','Warm tones for the last light.','heat',[2,7,3]],
 ['Velvet Dreams','Soft edges and vivid colors.','bloom',[3,8,0]],
 ['Outer Limits','Ambient textures from beyond.','orbit',[4,9,1]]
].map(([title,description,art,ids],i)=>({id:`p${i}`,type:'playlist',title,description,art,color:songs[i].color,tracks:ids.map(n=>`s${n}`)}));
