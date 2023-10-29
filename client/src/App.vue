<script setup lang="ts">
  import SparkMD5 from 'spark-md5'
  import { ref } from 'vue';
  // 1MB = 1024KB = 1024 * 1024 B
  const CHUNK_SIZE = 1024 * 1024 // 1M
  const fileHash = ref<string>('')
  const fileName = ref<string>('')
  // 文件分片
  const createChunks = (file: File) => {
    // 从0开始
    let cur = 0
    // 声明接收chunks的数组
    let chunks = []
    while(cur < file.size) {
      const blob = file.slice(cur, cur + CHUNK_SIZE)
      chunks.push(blob)
      cur += CHUNK_SIZE
    }
    return chunks
  }
  // hash计算
  const calculateHash = (chunks: Blob[]) => {
    return new Promise((resolve) => {
      // 存储需要计算hash的部分
      const target: Blob[] = []
      // 配置spark
      const spark = new SparkMD5.ArrayBuffer()
      const fileReader = new FileReader()
      
      // 第一个和最后一个的全部；中间部分取前中后各两个字节
      chunks.forEach((chunk, index) => {
        if(index === 0 || index === chunks.length - 1) {
          target.push(chunk)
        } else {
          target.push(chunk.slice(0, 2))
          target.push(chunk.slice(CHUNK_SIZE / 2, CHUNK_SIZE / 2 + 2))
          target.push(chunk.slice(CHUNK_SIZE - 2, CHUNK_SIZE))
        }
      })

      fileReader.readAsArrayBuffer(new Blob(target))
      // 注意：这个onload是异步的，计算hash的这个函数要返回Promise，确保后面使用的时候已经拿到hash值
      fileReader.onload = (e) => {
        spark.append((e.target as FileReader).result)
        // 此处拿到计算出来的hash值  spark.end()
        resolve(spark.end())
        
      }
    })
    
  }
  // 文件校验
  const verify = () => {
    return fetch('http://localhost:3000/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileHash: fileHash.value,
        fileName: fileName.value,
      })
    })
    .then(res => res.json())
    // .then(res => {
    //   return res
    // })
    
  }
  // 文件合并
  const mergeFile = () => {
    fetch('http://localhost:3000/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileHash: fileHash.value,
        fileName: fileName.value,
        size: CHUNK_SIZE
      })
    })
    .then(res => {
      alert('合并OK')
    })
  }
  // 上传分片
  const uploadChunks = async(chunks: Blob[], existChunks: string[]) => {
    // data对象数组是希望发送给服务端的内容
    const data = chunks.map((chunk, index) => {
      return {
        fileHash: fileHash.value,
        chunkHash: fileHash.value + '-' + index,
        chunk
      }
    })
    // 将对象数组转换为FormData数组
    // 考虑到断点续传，在上传之前，需要过滤掉已经传过的那部分切片
    const formDatas = data
    .filter((item) => {
      !existChunks.includes(item.chunkHash)
    })
    .map((item) => {
      const formData = new FormData()
      formData.append('fileHash', item.fileHash)
      formData.append('chunkHash', item.chunkHash)
      formData.append('chunk', item.chunk)
      return formData
    })
    // 浏览器会有上传请求的并发限制，需要做出约束
    const max = 6 // 最大并发请求数
    let index = 0 // 标识目前上传到第几个
    // 设置请求池，最多六个，完成一个就添加一个新的
    const taskPool: any = []
    while(index < formDatas.length) {
      const task = fetch('http://localhost:3000/upload', {
        method: 'POST',
        body: formDatas[index]
      })
      // ！！！下面这两行不理解啊，这样splice直接给task以及之后的都删了，然后还push?不懂
      taskPool.splice(taskPool.findIndex((item: any) => item === task))
      taskPool.push(task)
      // 如果请求池满了，就得等至少一个完成才可以添加
      if(taskPool.length === max) {
        await Promise.race(taskPool)
      }
      index++
    }
    await Promise.all(taskPool)

    // 上传完成后通知服务器合并文件
    mergeFile()
  }



  const handleUpload = async(e: Event) => {
    // 读取文件
    const files = (e.target as HTMLInputElement).files
    if(!files) return
    fileName.value = files[0].name
    
    // 文件分片
    const chunks = createChunks(files[0])
    
    // hash计算
    const hash = await calculateHash(chunks)
    fileHash.value = hash as string
    // 校验
    const vData = await verify()
    
    if(!vData.shouldUpload) {
      alert('秒传成功')
      return
    }
    
    // 文件上传&合并
    uploadChunks(chunks, vData.existChunks)

  }
</script>

<template>
  <div>
    <h1>大文件上传</h1>
    <input @change="handleUpload" type="file">
  </div>
</template>

<style scoped>

</style>
