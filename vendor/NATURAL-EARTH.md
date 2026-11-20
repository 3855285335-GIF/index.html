# 世界地图总览

海岸线和河流来自 Natural Earth 1:110m，属于公有领域。导航页将原始几何按类型合并，经纬度保留三位小数，供低倍率总览使用。街道及路线使用各自标注的来源。

- [陆地数据](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_land.geojson)
- [河流数据](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_rivers_lake_centerlines.geojson)
- [Natural Earth 使用条款](https://www.naturalearthdata.com/about/terms-of-use/)

低倍率地形图使用同一项目的 Natural Earth II 1:50m 陆地晕渲，按原始世界文件重投影到 Web Mercator，裁到南北纬 85.051129 度，并缩至 2560 像素。高倍率切换到有街道数据的图层。原始数据见 [Natural Earth II](https://naturalearth.s3.amazonaws.com/50m_raster/NE2_50M_SR_W.zip)。
